/**
 * Agent runs (design spec §14): the in-process run registry, the stream encoder and the combined
 * abort signal. One web process is assumed (design spec §17).
 */
export const RUN_TIME_LIMIT_MS = 180_000;
export const RUN_KEEPALIVE_MS = 15_000;

/** At most one open run per operator. */
export class RunRegistry {
  private readonly runs = new Map<string, AbortController>();

  get size(): number {
    return this.runs.size;
  }

  has(operatorId: string): boolean {
    return this.runs.has(operatorId);
  }

  /** Claims the operator's slot, or returns undefined when a run is already open. */
  claim(operatorId: string): AbortController | undefined {
    if (this.runs.has(operatorId)) return undefined;
    const controller = new AbortController();
    this.runs.set(operatorId, controller);
    return controller;
  }

  /** Releases the slot; only the owner of `controller` can release it. */
  release(operatorId: string, controller: AbortController): void {
    if (this.runs.get(operatorId) === controller) this.runs.delete(operatorId);
  }
}

const encoder = new TextEncoder();

/** One SSE frame: `event: <name>` and the JSON data on one line. */
export function encodeFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const KEEPALIVE = encoder.encode(': keepalive\n\n');

/**
 * The run's signal: the browser leaving (the request signal or the stream's cancel), or the
 * 180 s limit, whichever comes first.
 */
export function runSignal(requestSignal: AbortSignal, own: AbortController, limitMs = RUN_TIME_LIMIT_MS): { signal: AbortSignal; dispose: () => void } {
  const timer = setTimeout(() => own.abort(new Error('time limit')), limitMs);
  const onAbort = () => own.abort(new Error('browser left'));
  if (requestSignal.aborted) onAbort();
  else requestSignal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: own.signal,
    dispose: () => {
      clearTimeout(timer);
      requestSignal.removeEventListener('abort', onAbort);
    },
  };
}

/** Parses SSE text into frames (browser and tests). */
export function parseSse(text: string): { event?: string; data?: unknown; comment?: string }[] {
  const frames: { event?: string; data?: unknown; comment?: string }[] = [];
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    if (block.trim() === '') continue;
    const frame: { event?: string; data?: unknown; comment?: string } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) frame.comment = line.slice(1).trim();
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) {
        try {
          frame.data = JSON.parse(line.slice(6)) as unknown;
        } catch {
          frame.data = line.slice(6);
        }
      }
    }
    frames.push(frame);
  }
  return frames;
}
