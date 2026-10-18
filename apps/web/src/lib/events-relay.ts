/**
 * The live-update relay (design spec §13): the facilitator's `/v1/events` to the browser as SSE.
 * Frames pass through unchanged, the facilitator's comments are dropped, and the relay sends its
 * own keepalive. Operators get one upstream per browser connection; sellers share one upstream.
 */
export const RELAY_KEEPALIVE_MS = 15_000;
export const SELLER_IDLE_CLOSE_MS = 30_000;
export const KEEPALIVE_FRAME = ': keepalive\n\n';

const encoder = new TextEncoder();

export interface Timers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Keeps `event:`/`data:` lines of one SSE block, drops comments; undefined for a comment-only block. */
export function filterBlock(block: string): string | undefined {
  const lines = block.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
  return lines.length === 0 ? undefined : `${lines.join('\n')}\n\n`;
}

/** Splits a buffer into complete SSE blocks and the rest. */
export function splitBlocks(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { blocks: parts, rest };
}

/** Reads an upstream SSE body and calls `onFrame` with each kept frame. Resolves when it ends. */
export async function pumpFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { blocks, rest } = splitBlocks(buffer);
      buffer = rest;
      for (const block of blocks) {
        const frame = filterBlock(block);
        if (frame !== undefined) onFrame(frame);
      }
    }
  } catch {
    // An aborted or broken upstream simply ends the pump.
  } finally {
    reader.releaseLock();
  }
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export type UpstreamOpen = (signal: AbortSignal) => Promise<Response>;

export type RelayOutcome = { ok: true; response: Response } | { ok: false; status: number };

/**
 * One operator browser connection: opens its own upstream with the operator key, and aborts it
 * when the browser leaves (the request signal, or the stream's cancel).
 */
export async function operatorRelay(options: { open: UpstreamOpen; requestSignal: AbortSignal; timers?: Timers; keepaliveMs?: number }): Promise<RelayOutcome> {
  const timers = options.timers ?? realTimers;
  const upstreamAbort = new AbortController();
  const onBrowserAbort = () => upstreamAbort.abort();
  options.requestSignal.addEventListener('abort', onBrowserAbort);
  let upstream: Response;
  try {
    upstream = await options.open(upstreamAbort.signal);
  } catch {
    options.requestSignal.removeEventListener('abort', onBrowserAbort);
    return { ok: false, status: 502 };
  }
  if (upstream.status !== 200 || upstream.body === null) {
    options.requestSignal.removeEventListener('abort', onBrowserAbort);
    await upstream.body?.cancel().catch(() => undefined);
    return { ok: false, status: upstream.status };
  }
  const body = upstream.body;
  let keepalive: unknown;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        timers.clearInterval(keepalive);
        upstreamAbort.abort();
        options.requestSignal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          // Already closed by the browser.
        }
      };
      options.requestSignal.addEventListener('abort', close);
      send(': connected\n\n');
      keepalive = timers.setInterval(() => send(KEEPALIVE_FRAME), options.keepaliveMs ?? RELAY_KEEPALIVE_MS);
      void pumpFrames(body, send).then(close);
    },
    cancel() {
      closed = true;
      timers.clearInterval(keepalive);
      upstreamAbort.abort();
    },
  });
  return { ok: true, response: new Response(stream, { headers: SSE_HEADERS }) };
}

interface Subscriber {
  send: (frame: string) => void;
  end: () => void;
}

/**
 * The seller's shared upstream: opened on the first subscriber, fanned out to every connected
 * seller browser, and closed 30 s after the last one leaves.
 */
export class SellerHub {
  private readonly open: UpstreamOpen;
  private readonly timers: Timers;
  private readonly idleCloseMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private upstream: { abort: AbortController; ready: Promise<number> } | undefined;
  private idleTimer: unknown;
  /** How many upstream connections were opened (tests). */
  opened = 0;

  constructor(open: UpstreamOpen, options: { timers?: Timers; idleCloseMs?: number } = {}) {
    this.open = open;
    this.timers = options.timers ?? realTimers;
    this.idleCloseMs = options.idleCloseMs ?? SELLER_IDLE_CLOSE_MS;
  }

  get size(): number {
    return this.subscribers.size;
  }

  get connected(): boolean {
    return this.upstream !== undefined;
  }

  private ensureUpstream(): Promise<number> {
    if (this.upstream !== undefined) return this.upstream.ready;
    const abort = new AbortController();
    this.opened += 1;
    const ready = this.open(abort.signal).then(
      (res) => {
        if (res.status !== 200 || res.body === null) {
          void res.body?.cancel().catch(() => undefined);
          if (this.upstream?.abort === abort) this.upstream = undefined;
          return res.status;
        }
        void pumpFrames(res.body, (frame) => {
          for (const s of this.subscribers) s.send(frame);
        }).then(() => {
          if (this.upstream?.abort !== abort) return;
          // The upstream ended: end every subscriber; browsers reconnect and refresh.
          this.upstream = undefined;
          for (const s of [...this.subscribers]) s.end();
        });
        return 200;
      },
      () => {
        if (this.upstream?.abort === abort) this.upstream = undefined;
        return 502;
      },
    );
    this.upstream = { abort, ready };
    return ready;
  }

  /** Adds a subscriber; resolves with the upstream status (200 when connected). */
  async subscribe(subscriber: Subscriber): Promise<{ status: number; unsubscribe: () => void }> {
    if (this.idleTimer !== undefined) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const status = await this.ensureUpstream();
    if (status !== 200) {
      this.scheduleIdleClose();
      return { status, unsubscribe: () => {} };
    }
    this.subscribers.add(subscriber);
    return {
      status,
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
        this.scheduleIdleClose();
      },
    };
  }

  private scheduleIdleClose(): void {
    if (this.subscribers.size > 0 || this.idleTimer !== undefined) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (this.subscribers.size > 0) return;
      this.upstream?.abort.abort();
      this.upstream = undefined;
    }, this.idleCloseMs);
  }

  /** A browser stream for one seller subscriber. */
  async relay(requestSignal: AbortSignal, keepaliveMs = RELAY_KEEPALIVE_MS): Promise<RelayOutcome> {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    let keepalive: unknown;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      this.timers.clearInterval(keepalive);
      requestSignal.removeEventListener('abort', close);
      unsubscribe();
      try {
        controllerRef?.close();
      } catch {
        // Already closed.
      }
    };
    const send = (text: string) => {
      if (closed || controllerRef === undefined) return;
      try {
        controllerRef.enqueue(encoder.encode(text));
      } catch {
        close();
      }
    };
    const result = await this.subscribe({ send, end: close });
    if (result.status !== 200) return { ok: false, status: result.status };
    unsubscribe = result.unsubscribe;
    if (requestSignal.aborted) {
      close();
      return { ok: false, status: 499 };
    }
    requestSignal.addEventListener('abort', close);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        send(': connected\n\n');
        keepalive = this.timers.setInterval(() => send(KEEPALIVE_FRAME), keepaliveMs);
      },
      cancel: () => close(),
    });
    return { ok: true, response: new Response(stream, { headers: SSE_HEADERS }) };
  }
}
