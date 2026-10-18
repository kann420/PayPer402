/**
 * The Waiting state's `/refresh` poll and its "Check again" (design spec §10.3, §10.13). Plain
 * TypeScript with injected timers, so the scheduling rules are testable without React:
 *
 * - A tick asks every `intervalMs`, for up to `limitMs` from the start of the window.
 * - "Check again" asks at once and restarts the window. It cancels the pending tick, and the
 *   next tick runs `intervalMs` after its answer.
 * - One request at a time. A check made while a tick's request is running waits for that answer,
 *   then asks.
 * - While a check runs, `onChecking(true)`; its button is disabled.
 * - When `apply` returns false (the page refreshes into another card, or the session ended), the
 *   ticks stop, but "Check again" still works.
 */

export interface WaitingPollDeps<A> {
  /** One `/refresh` call. It must resolve; a rejection counts as an answer that changes nothing. */
  request: () => Promise<A>;
  /** Applies an answer. Returns false when the ticks should stop. */
  apply: (answer: A) => boolean;
  onChecking: (checking: boolean) => void;
  schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (handle: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  intervalMs: number;
  limitMs: number;
}

export class WaitingPoll<A> {
  private readonly deps: WaitingPollDeps<A>;
  private windowStart = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight = false;
  /** A "Check again" is waiting for, or running, its own request. */
  private checking = false;
  /** The check's request still has to be sent (a tick's request was running). */
  private queued = false;
  private disposed = false;

  constructor(deps: WaitingPollDeps<A>) {
    this.deps = deps;
  }

  /** Opens the window and schedules the first tick. */
  start(): void {
    this.windowStart = this.deps.now();
    this.scheduleTick();
  }

  /** "Check again". Ignored while a check is already running. */
  checkNow(): void {
    if (this.disposed || this.checking) return;
    this.clearTimer();
    this.windowStart = this.deps.now();
    this.setChecking(true);
    if (this.inflight) this.queued = true;
    else void this.run(true);
  }

  /** Stops everything; an answer still on its way is ignored. */
  dispose(): void {
    this.disposed = true;
    this.queued = false;
    this.clearTimer();
    this.setChecking(false);
  }

  private setChecking(checking: boolean): void {
    if (this.checking === checking) return;
    this.checking = checking;
    this.deps.onChecking(checking);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.deps.cancel(this.timer);
    this.timer = undefined;
  }

  private scheduleTick(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = this.deps.schedule(() => {
      this.timer = undefined;
      if (this.deps.now() - this.windowStart > this.deps.limitMs) return;
      void this.run(false);
    }, this.deps.intervalMs);
  }

  private async run(manual: boolean): Promise<void> {
    this.inflight = true;
    let keep = true;
    try {
      const answer = await this.deps.request();
      if (!this.disposed) keep = this.deps.apply(answer);
    } catch {
      // Nothing changed; carry on as if the wallet were still waiting.
    } finally {
      this.inflight = false;
    }
    if (this.disposed) return;
    if (this.queued) {
      this.queued = false;
      if (keep) {
        void this.run(true);
        return;
      }
    }
    if (manual || !keep) this.setChecking(false);
    if (keep) this.scheduleTick();
  }
}
