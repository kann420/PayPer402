import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { filterBlock, operatorRelay, SellerHub, splitBlocks, type Timers } from '../events-relay';
import { parseSse } from '../runs';
import { body, createWebHarness, type WebHarness } from '../test-support';
import { createEventsHandler } from './events';
import { createSettleHandler } from './operator';
import { createSessionHandler } from './session';

const encoder = new TextEncoder();

/** A controllable upstream SSE body. */
function upstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    get aborted() {
      return aborted;
    },
    open: (signal: AbortSignal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        try {
          controller.error(new Error('aborted'));
        } catch {
          // Already closed.
        }
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    },
  };
}

/** Timers driven by the test. */
function manualTimers() {
  let next = 1;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  const timers: Timers = {
    setInterval: (fn) => {
      const id = next++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (h) => void intervals.delete(h as number),
    setTimeout: (fn) => {
      const id = next++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
  };
  return {
    timers,
    tickIntervals: () => [...intervals.values()].forEach((fn) => fn()),
    runTimeouts: () => {
      const all = [...timeouts.entries()];
      timeouts.clear();
      for (const [, fn] of all) fn();
    },
    pendingTimeouts: () => timeouts.size,
  };
}

async function readSome(response: Response, until: (text: string) => boolean): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!until(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { text, reader };
}

describe('frame filtering', () => {
  it('keeps event and data lines and drops comments', () => {
    expect(filterBlock(': connected')).toBeUndefined();
    expect(filterBlock(': keepalive')).toBeUndefined();
    expect(filterBlock('event: commitment.recorded\ndata: {"id":"c"}')).toBe('event: commitment.recorded\ndata: {"id":"c"}\n\n');
    expect(splitBlocks('event: a\ndata: 1\n\nevent: b')).toEqual({ blocks: ['event: a\ndata: 1'], rest: 'event: b' });
  });
});

describe('operator relay', () => {
  it('passes upstream frames through unchanged, drops comments, sends its keepalive, and aborts upstream on browser abort', async () => {
    const up = upstream();
    const t = manualTimers();
    const browser = new AbortController();
    const outcome = await operatorRelay({ open: up.open, requestSignal: browser.signal, timers: t.timers });
    if (!outcome.ok) throw new Error('relay failed');
    up.push(': connected\n\n');
    up.push('event: settlement.updated\ndata: {"id":"stl_1","status":"completed"}\n\n');
    up.push(': keepalive\n\n');
    t.tickIntervals();
    const { text, reader } = await readSome(outcome.response, (s) => s.includes('settlement.updated') && s.split(': keepalive').length > 1);
    const frames = parseSse(text);
    expect(frames.filter((f) => f.event !== undefined)).toEqual([{ event: 'settlement.updated', data: { id: 'stl_1', status: 'completed' } }]);
    // The relay's own comments: ": connected" first, then its keepalive; the facilitator's are dropped.
    expect(frames.filter((f) => f.comment !== undefined).map((f) => f.comment)).toEqual(['connected', 'keepalive']);
    browser.abort();
    await vi.waitFor(() => expect(up.aborted).toBe(true));
    await reader.cancel().catch(() => undefined);
  });

  it('maps an upstream 429 to a failure the handler answers with 429', async () => {
    const outcome = await operatorRelay({
      open: () => Promise.resolve(new Response('{"error":"too_many_streams"}', { status: 429 })),
      requestSignal: new AbortController().signal,
    });
    expect(outcome).toEqual({ ok: false, status: 429 });
  });
});

describe('seller hub', () => {
  it('shares one upstream between subscribers and closes it 30 s after the last one leaves', async () => {
    const up = upstream();
    const t = manualTimers();
    const hub = new SellerHub(up.open, { timers: t.timers });
    const a = new AbortController();
    const b = new AbortController();
    const first = await hub.relay(a.signal);
    const second = await hub.relay(b.signal);
    if (!first.ok || !second.ok) throw new Error('relay failed');
    expect(hub.opened).toBe(1);
    up.push('event: commitment.recorded\ndata: {"id":"c1","agentRef":"3f9a1be1"}\n\n');
    const one = await readSome(first.response, (s) => s.includes('commitment.recorded'));
    const two = await readSome(second.response, (s) => s.includes('commitment.recorded'));
    expect(one.text).toContain('"agentRef":"3f9a1be1"');
    expect(two.text).toContain('"agentRef":"3f9a1be1"');
    a.abort();
    expect(hub.size).toBe(1);
    expect(t.pendingTimeouts()).toBe(0);
    b.abort();
    expect(hub.size).toBe(0);
    expect(t.pendingTimeouts()).toBe(1);
    expect(up.aborted).toBe(false);
    t.runTimeouts();
    expect(up.aborted).toBe(true);
    expect(hub.connected).toBe(false);
    await one.reader.cancel().catch(() => undefined);
    await two.reader.cancel().catch(() => undefined);
  });

  it('keeps the upstream when a subscriber returns within 30 s', async () => {
    const up = upstream();
    const t = manualTimers();
    const hub = new SellerHub(up.open, { timers: t.timers });
    const a = new AbortController();
    await hub.relay(a.signal);
    a.abort();
    expect(t.pendingTimeouts()).toBe(1);
    const b = new AbortController();
    await hub.relay(b.signal);
    expect(t.pendingTimeouts()).toBe(0);
    expect(hub.opened).toBe(1);
    b.abort();
    t.runTimeouts();
    expect(up.aborted).toBe(true);
  });
});

describe('GET /api/events and Charge now (integration)', () => {
  let w: WebHarness;
  afterEach(async () => {
    w.h.checkInvariants();
    await w.close();
  });

  it('needs a session for its scope, and relays settlement.updated after a manual charge of exactly the sum', async () => {
    w = await createWebHarness();
    const denied = await createEventsHandler(w.deps)(w.request('/api/events?scope=operator'));
    expect(denied.status).toBe(401);
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'operator' } })));
    const operatorId = w.session()?.operator?.id as string;
    const { agentId } = w.h.addAgent(operatorId);
    w.h.activateWallet(operatorId);
    for (const amount of [2, 5, 1]) w.h.addCommitment({ operatorId, agentId, payTo: w.sellerId, amount });

    const browser = new AbortController();
    const events = await createEventsHandler(w.deps)(
      new Request('http://localhost:3000/api/events?scope=operator', { headers: { cookie: `pp402_session=${w.jar.value}` }, signal: browser.signal }),
    );
    expect(events.status).toBe(200);
    const reading = readSome(events, (s) => s.includes('"status":"completed"'));
    await new Promise((r) => setTimeout(r, 50));

    const res = await createSettleHandler(w.deps)(w.request('/api/operator/settlements', { body: {} }));
    expect(res.status).toBe(201);
    expect(await body(res)).toMatchObject({ settlement: { status: 'completed', amount: 8, callsCount: 3, trigger: 'manual' } });
    expect(w.h.paypal.callsOf('chargeVaultedWallet')).toEqual([[expect.objectContaining({ amountCents: 8 })]]);

    const { text, reader } = await reading;
    const updates = parseSse(text).filter((f) => f.event === 'settlement.updated');
    expect(updates.map((f) => (f.data as { status: string }).status)).toEqual(['pending', 'completed']);
    browser.abort();
    await reader.cancel().catch(() => undefined);

    const again = await createSettleHandler(w.deps)(w.request('/api/operator/settlements', { body: {} }));
    expect(again.status).toBe(409);
    expect(await body(again)).toMatchObject({ error: 'nothing_to_settle' });
  });
});
