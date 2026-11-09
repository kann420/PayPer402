/**
 * In-process sliding-window rate limits (operator-cli.md §9.3). One facilitator process is assumed;
 * a restart resets them. The same shape as the web app's limiter, written here because the
 * facilitator must not depend on the web app.
 */
import type { Request, RequestHandler } from 'express';
import { HttpError } from './http';

/** Keys beyond this many trigger a sweep of expired ones, so rotating client keys cannot grow the map without bound. */
const SWEEP_ABOVE = 10_000;

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

  /** True when one more hit would stay within the limit. */
  allows(key: string): boolean {
    return this.live(key).length < this.max;
  }

  /** Records a hit. */
  hit(key: string): void {
    if (this.hits.size > SWEEP_ABOVE) for (const other of [...this.hits.keys()]) this.live(other);
    const list = this.live(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  /** Whole seconds until the oldest hit of `key` leaves the window, at least 1. */
  retryAfterSeconds(key: string): number {
    const oldest = this.live(key)[0];
    if (oldest === undefined) return 1;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** The per-client key: the first `X-Forwarded-For` address behind a trusted proxy, else one shared bucket. */
export function clientKey(req: Pick<Request, 'get'>, trustProxy: boolean): string {
  if (!trustProxy) return 'shared';
  const first = req.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first === undefined || first === '' ? 'shared' : first;
}

/**
 * Answers 429 `too_many_requests` with `Retry-After` when any window is full, and records nothing
 * in that case. Otherwise it records one hit in every window.
 */
export function rateLimit(windows: readonly (readonly [SlidingWindow, (req: Request) => string])[]): RequestHandler {
  return (req, res, next) => {
    const keyed = windows.map(([window, keyOf]) => [window, keyOf(req)] as const);
    const full = keyed.filter(([window, key]) => !window.allows(key));
    if (full.length > 0) {
      const retryAfter = Math.max(...full.map(([window, key]) => window.retryAfterSeconds(key)));
      res.setHeader('Retry-After', String(retryAfter));
      next(new HttpError(429, 'too_many_requests', 'Too many requests. Try again later.'));
      return;
    }
    for (const [window, key] of keyed) window.hit(key);
    next();
  };
}
