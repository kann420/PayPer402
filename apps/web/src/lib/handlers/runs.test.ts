import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { CatalogError, openSession, runAgent, type AgentRunResult, type OpenSessionOptions, type RunAgentOptions } from '@payper402/agent';
import { fakeAnthropic, message, toolUse } from '@payper402/agent/test-support';
import { RunRegistry, parseSse } from '../runs';
import { body, createWebHarness, type WebHarness } from '../test-support';
import { createAgentsHandler } from './operator';
import { createRunsHandler, parseBudget, type RunDeps } from './runs';
import { createSessionHandler } from './session';

let w: WebHarness;
let agentId: string;
let operatorId: string;

async function setup(options: { withSeller?: boolean; env?: Record<string, string> } = {}) {
  w = await createWebHarness(options);
  w.h.clock.now = Math.floor(Date.now() / 1000);
  w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'operator' } })));
  operatorId = w.session()?.operator?.id as string;
  const created = w.keep(await createAgentsHandler(w.deps)(w.request('/api/operator/agents', { body: { name: 'research-bot' } })));
  agentId = ((await body(created)) as { agent: { id: string } }).agent.id;
}

afterEach(async () => {
  w.h.checkInvariants();
  await w.close();
});

/** Run deps with an injected runner; nothing reaches Anthropic or TypeSafe. */
function fakeRun(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    registry: new RunRegistry(),
    anthropic: () => fakeAnthropic([]).client,
    runAgent: async (options) => runAgent(options),
    openSession: (options: OpenSessionOptions) => openSession({ ...options, nowSeconds: () => w.h.clock.now }),
    ...overrides,
  };
}

const post = (handler: (r: Request) => Promise<Response>, payload: unknown = { agentId, task: 'Brief me on coffee', budget: '1.00' }) =>
  handler(w.request('/api/runs', { body: payload }));

const readAll = async (res: Response) => parseSse(await res.text());

describe('POST /api/runs: checks before the stream', () => {
  beforeEach(async () => {
    await setup({ env: { WEB_LIMIT_RUNS_PER_DAY: '2', WEB_LIMIT_RUNS_PER_HOUR: '100' } });
  });

  it('validates the body and the budget range', async () => {
    const handler = createRunsHandler(w.deps, fakeRun());
    for (const bad of [{ agentId, task: '', budget: '1.00' }, { agentId, task: 'x'.repeat(501), budget: '1.00' }, { agentId, task: 't', budget: '5.01' }, { agentId, task: 't', budget: '0' }, { agentId, task: 't' }]) {
      const res = await post(handler, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(parseBudget('0.01')).toBe(1);
    expect(parseBudget('5.00')).toBe(500);
    expect(parseBudget('$1')).toBe(100);
    expect(parseBudget('abc')).toBeUndefined();
  });

  it('answers 404 agent_key_missing without the key in the session', async () => {
    const res = await post(createRunsHandler(w.deps, fakeRun()), { agentId: 'agt_other', task: 't', budget: '1.00' });
    expect(res.status).toBe(404);
    expect(await body(res)).toMatchObject({ error: 'agent_key_missing' });
  });

  it('answers 409 run_in_progress to a second concurrent run, and releases the slot when the request aborts', async () => {
    let entered!: () => void;
    const inRun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sawAbort: boolean[] = [];
    const run = fakeRun({
      openSession: async () => ({ catalog: { seller: { name: 'S', payTo: 'p' }, scheme: '', network: '', asset: '', services: [] } }) as never,
      runAgent: async (options: RunAgentOptions): Promise<AgentRunResult> => {
        entered();
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
        sawAbort.push(options.signal?.aborted === true);
        throw new Error('aborted');
      },
    });
    const handler = createRunsHandler(w.deps, run);
    const browser = new AbortController();
    const first = await handler(new Request('http://localhost:3000/api/runs', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', cookie: `pp402_session=${w.jar.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, task: 't', budget: '1.00' }),
      signal: browser.signal,
    }));
    expect(first.status).toBe(200);
    const reading = first.text();
    await inRun;
    expect(run.registry.has(operatorId)).toBe(true);
    const second = await post(handler);
    expect(second.status).toBe(409);
    expect(await body(second)).toMatchObject({ error: 'run_in_progress' });
    browser.abort();
    const text = await reading.catch(() => '');
    expect(sawAbort).toEqual([true]);
    await vi.waitFor(() => expect(run.registry.has(operatorId)).toBe(false));
    expect(text === '' || parseSse(text).at(-1)?.event === 'error').toBe(true);
  });

  it('applies the per-operator daily limit', async () => {
    const quick = fakeRun({
      openSession: async () => ({ catalog: { seller: { name: 'S', payTo: 'p' }, scheme: '', network: '', asset: '', services: [] } }) as never,
      runAgent: async () => ({ status: 'completed', answer: '', report: {} as never, events: [] }),
    });
    const handler = createRunsHandler(w.deps, quick);
    for (let i = 0; i < 2; i++) await readAll(await post(handler));
    const third = await post(handler);
    expect(third.status).toBe(429);
    expect(await body(third)).toMatchObject({ error: 'run_limit' });
  });

  it('sends an error frame after a CatalogError', async () => {
    const handler = createRunsHandler(
      w.deps,
      fakeRun({
        openSession: async () => {
          throw new CatalogError('Could not reach the seller at http://127.0.0.1:9');
        },
      }),
    );
    const frames = await readAll(await post(handler));
    expect(frames.map((f) => f.event)).toEqual(['error']);
    expect(frames[0]?.data).toEqual({ message: "The agent couldn't start: Could not reach the seller at http://127.0.0.1:9" });
  });
});

describe('POST /api/runs: the global hour limit', () => {
  it('counts runs of all operators', async () => {
    await setup({ env: { WEB_LIMIT_RUNS_PER_HOUR: '1' } });
    const quick = fakeRun({
      openSession: async () => ({ catalog: { seller: { name: 'S', payTo: 'p' }, scheme: '', network: '', asset: '', services: [] } }) as never,
      runAgent: async () => ({ status: 'completed', answer: '', report: {} as never, events: [] }),
    });
    const handler = createRunsHandler(w.deps, quick);
    await readAll(await post(handler));
    expect((await post(handler)).status).toBe(429);
  });
});

describe('POST /api/runs: integration (harness, demo seller with fake AI, scripted Claude)', () => {
  beforeEach(async () => {
    await setup({ withSeller: true });
  });

  it('streams catalog, the agent frames and end; the paid calls are in the ledger', async () => {
    w.h.activateWallet(operatorId);
    const sellerUrl = w.seller?.url as string;
    const claude = fakeAnthropic([
      message([{ type: 'text', text: 'I will buy the quote, then a summary.' }, toolUse('list_services', {})]),
      message([toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Current price' })]),
      message([toolUse('call_service', { service_id: 'summarize', params: { url: `${sellerUrl}/news/coffee-highland-rains-delay-harvest` }, reason: 'Top news' })]),
      message([toolUse('finish', { answer: 'Coffee is up (simulated data).', spend_explanation: 'I paid for a quote and a summary.' })]),
    ]);
    const handler = createRunsHandler(w.deps, fakeRun({ anthropic: () => claude.client }));
    const res = await post(handler);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await readAll(res)).filter((f) => f.event !== undefined);
    expect(frames[0]?.event).toBe('catalog');
    expect((frames[0]?.data as { services: { id: string }[] }).services.map((s) => s.id)).toEqual(['quote', 'summarize', 'translate', 'premium_news']);
    expect(frames.at(-1)).toEqual({ event: 'end', data: { status: 'completed' } });
    const events = frames.slice(1, -1).map((f) => {
      expect(f.event).toBe('agent');
      return f.data as { type: string; commitmentId?: string; amountCents?: number };
    });
    expect(events[0]?.type).toBe('started');
    expect(events[1]).toMatchObject({ type: 'thinking' });
    const paid = events.filter((e) => e.type === 'paid');
    expect(paid.map((e) => e.amountCents)).toEqual([2, 5]);
    const ledger = await w.deps.facilitator.operator(w.session()?.operator?.key as string).commitments({ limit: 50 });
    expect(new Set(ledger.commitments.map((c) => c.id))).toEqual(new Set(paid.map((e) => e.commitmentId)));
    // The Claude request used the configured model, and the per-call limit min(caps.perCall, budget).
    expect(claude.requests[0]?.body['model']).toBe('claude-test-model');
    const first = (claude.requests[0]?.body['messages'] as { content: string }[])[0]?.content;
    expect(first).toContain('Per-call limit: $0.10.');
  });

  it('a wallet that is not linked ends in one refused wallet_not_linked', async () => {
    const claude = fakeAnthropic([
      message([toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Current price' })]),
      message([toolUse('finish', { answer: 'Payments were refused.', spend_explanation: 'Nothing was paid.' })]),
    ]);
    const frames = await readAll(await post(createRunsHandler(w.deps, fakeRun({ anthropic: () => claude.client }))));
    const refused = frames.filter((f) => f.event === 'agent' && (f.data as { type: string }).type === 'refused');
    expect(refused.map((f) => f.data)).toEqual([expect.objectContaining({ code: 'wallet_not_linked', by: 'facilitator' })]);
  });
});
