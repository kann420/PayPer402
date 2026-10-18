/**
 * In-process sliding-window limits (design spec §15.3). One web process is assumed; a restart
 * resets them.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  readonly max: number;
  readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Hits in the window for `key`. */
  count(key: string): number {
    return this.live(key).length;
  }

  /** True when one more hit would stay within the limit. */
  allows(key: string): boolean {
    return this.live(key).length < this.max;
  }

  /** Records a hit. */
  hit(key: string): void {
    const list = this.live(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  /** Records a hit when every window allows it; otherwise records nothing. */
  static take(entries: [SlidingWindow, string][]): boolean {
    if (!entries.every(([w, key]) => w.allows(key))) return false;
    for (const [w, key] of entries) w.hit(key);
    return true;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The per-client key: the first `X-Forwarded-For` address behind a trusted proxy, else one shared bucket. */
export function clientKey(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return 'all';
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first === undefined || first === '' ? 'unknown' : first;
}
