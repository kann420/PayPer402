import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitingPoll } from './waiting-poll';

const INTERVAL = 3000;
const LIMIT = 10 * 60 * 1000;

/** A `/refresh` stand-in: every request waits until the test answers it. */
function harness(apply: (answer: string) => boolean = (answer) => answer === 'waiting') {
  const pending: ((answer: string) => void)[] = [];
  let open = 0;
  let maxOpen = 0;
  const sentAt: number[] = [];
  const checking: boolean[] = [];
  const poll = new WaitingPoll<string>({
    request: () => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      sentAt.push(Date.now());
      return new Promise<string>((resolve) => {
        pending.push((answer) => {
          open -= 1;
          resolve(answer);
        });
      });
    },
    apply,
    onChecking: (value) => checking.push(value),
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle),
    now: () => Date.now(),
    intervalMs: INTERVAL,
    limitMs: LIMIT,
  });
  return {
    poll,
    sentAt,
    checking,
    maxOpen: () => maxOpen,
    /** Answers the oldest open request and lets its continuation run. */
    async answer(value = 'waiting') {
      const next = pending.shift();
      if (!next) throw new Error('no open request');
      next(value);
      await vi.advanceTimersByTimeAsync(0);
    },
    openCount: () => pending.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WaitingPoll', () => {
  it('ticks every 3 s after each answer, and stops ticking when the 10-minute window has passed', async () => {
    const t = harness();
    t.poll.start();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(t.sentAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sentAt).toEqual([3000]);
    await vi.advanceTimersByTimeAsync(500);
    await t.answer();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(t.sentAt).toEqual([3000, 6500]);
    await t.answer();
    // Jump past the window: the next tick finds it closed and sends nothing.
    vi.setSystemTime(LIMIT + 1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(t.sentAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(t.sentAt).toHaveLength(2);
  });

  it('"Check again" asks at once, cancels the pending tick, and the next tick runs 3 s after its answer', async () => {
    const t = harness();
    t.poll.start();
    await vi.advanceTimersByTimeAsync(2000);
    t.poll.checkNow();
    expect(t.sentAt).toEqual([2000]);
    expect(t.checking).toEqual([true]);
    // The tick that was due at 3000 was cancelled.
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.sentAt).toEqual([2000]);
    await t.answer();
    expect(t.checking).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(t.sentAt).toEqual([2000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sentAt).toEqual([2000, 7000]);
    expect(t.maxOpen()).toBe(1);
  });

  it('ignores a second click while its request runs (the button is disabled)', async () => {
    const t = harness();
    t.poll.start();
    t.poll.checkNow();
    t.poll.checkNow();
    expect(t.sentAt).toHaveLength(1);
    expect(t.checking).toEqual([true]);
    await t.answer();
    t.poll.checkNow();
    expect(t.sentAt).toHaveLength(2);
  });

  it('works after the window closed, and restarts the 10-minute window', async () => {
    const t = harness();
    t.poll.start();
    vi.setSystemTime(LIMIT + 1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(t.sentAt).toEqual([]);
    t.poll.checkNow();
    expect(t.sentAt).toEqual([LIMIT + INTERVAL + 1]);
    await t.answer();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(t.sentAt).toHaveLength(2);
  });

  it('never overlaps a running tick: the check waits for its answer, then asks', async () => {
    const t = harness();
    t.poll.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(t.sentAt).toEqual([3000]);
    await vi.advanceTimersByTimeAsync(400);
    t.poll.checkNow();
    expect(t.openCount()).toBe(1);
    expect(t.checking).toEqual([true]);
    await vi.advanceTimersByTimeAsync(100);
    await t.answer();
    expect(t.sentAt).toEqual([3000, 3500]);
    expect(t.checking).toEqual([true]);
    await t.answer();
    expect(t.checking).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(t.sentAt).toEqual([3000, 3500, 6500]);
    expect(t.maxOpen()).toBe(1);
  });

  it('stops ticking when an answer moves the page on, but still accepts "Check again"', async () => {
    const t = harness();
    t.poll.start();
    t.poll.checkNow();
    await t.answer('active');
    expect(t.checking).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(t.sentAt).toHaveLength(1);
    t.poll.checkNow();
    expect(t.sentAt).toHaveLength(2);
  });

  it('a queued check is dropped when the running tick moves the page on', async () => {
    const t = harness();
    t.poll.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    t.poll.checkNow();
    await t.answer('active');
    expect(t.sentAt).toHaveLength(1);
    expect(t.checking).toEqual([true, false]);
  });

  it('a rejected request changes nothing and the ticks go on', async () => {
    let calls = 0;
    const poll = new WaitingPoll<string>({
      request: async () => {
        calls += 1;
        throw new Error('boom');
      },
      apply: () => true,
      onChecking: () => undefined,
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle),
      now: () => Date.now(),
      intervalMs: INTERVAL,
      limitMs: LIMIT,
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(calls).toBe(2);
    poll.dispose();
  });

  it('dispose stops the ticks and ignores an answer on its way', async () => {
    const applied: string[] = [];
    const t = harness((answer) => {
      applied.push(answer);
      return true;
    });
    t.poll.start();
    t.poll.checkNow();
    t.poll.dispose();
    expect(t.checking).toEqual([true, false]);
    await t.answer();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(applied).toEqual([]);
    expect(t.sentAt).toHaveLength(1);
  });
});
