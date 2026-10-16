import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  CHECK_DEADLINE_MS,
  DEFAULT_SPEND_POLICY,
  JEV_MODEL,
  SpendCheckError,
  applySpendPolicy,
  buildSpendCheckState,
  cut,
  describeDecisionLayer,
  judgeSpendCheck,
  resultExcerpt,
  setupDecisionLayer,
  type SpendCheck,
  type SpendCheckInput,
  type SpendCheckResult,
  type SpendPolicy,
} from './spend-check';

const input = (overrides: Partial<SpendCheckInput> = {}): SpendCheckInput => ({
  task: 'Brief me on coffee.',
  call: { serviceName: 'Market Quote API', serviceDescription: 'Latest futures price.', params: { symbol: 'KC' } },
  earlier: [],
  ...overrides,
});

const policy = (notNeeded: 'enforce' | 'observe', covered: 'enforce' | 'observe', notNeededBelow = 0.4, coveredAbove = 0.6): SpendPolicy => ({
  notNeededBelow,
  coveredAbove,
  modes: { not_needed: notNeeded, already_covered: covered },
});

describe('cut and the state', () => {
  it('keeps a 600-character value and cuts a 601-character one to 599 plus "…"', () => {
    expect(cut('a'.repeat(600), 600)).toBe('a'.repeat(600));
    const cutValue = cut('b'.repeat(601), 600);
    expect(cutValue).toHaveLength(600);
    expect(cutValue).toBe(`${'b'.repeat(599)}…`);
  });

  it('cuts string params in the proposed call and the earlier results, the task at 2,000, and keeps numbers', () => {
    const long = 'x'.repeat(700);
    const state = buildSpendCheckState(
      input({
        task: 't'.repeat(2001),
        call: { serviceName: 'Translate API', serviceDescription: 'Translates.', params: { text: long, n: 12345 } },
        earlier: [{ serviceName: 'Translate API', params: { text: long, n: 7 }, resultExcerpt: 'e'.repeat(900) }],
      }),
    );
    expect(state.task).toBe(`${'t'.repeat(1999)}…`);
    expect(state.proposed_call.params).toEqual({ text: `${'x'.repeat(599)}…`, n: 12345 });
    expect(state.earlier_results[0]?.params).toEqual({ text: `${'x'.repeat(599)}…`, n: 7 });
    expect(state.earlier_results[0]?.result_excerpt).toBe('e'.repeat(600));
    expect(buildSpendCheckState(input({ task: 't'.repeat(2000) })).task).toHaveLength(2000);
  });

  it('uses the field names of design spec §4.4', () => {
    const state = buildSpendCheckState(
      input({ earlier: [{ serviceName: 'Market Quote API', params: { symbol: 'KC' }, resultExcerpt: '{"price":1}' }] }),
    );
    expect(JSON.stringify(state)).toBe(
      '{"task":"Brief me on coffee.","proposed_call":{"service":"Market Quote API","description":"Latest futures price.","params":{"symbol":"KC"}},' +
        '"earlier_results":[{"service":"Market Quote API","params":{"symbol":"KC"},"result_excerpt":"{\\"price\\":1}"}]}',
    );
  });

  it('never mutates the input', () => {
    const value = input({
      task: 't'.repeat(3000),
      earlier: Array.from({ length: 40 }, () => ({ serviceName: 'S', params: { text: 'p'.repeat(700) }, resultExcerpt: 'r'.repeat(700) })),
    });
    const copy = structuredClone(value);
    buildSpendCheckState(value);
    expect(value).toEqual(copy);
  });

  it('drops the oldest earlier results until the state fits 16,000 characters', () => {
    const earlier = Array.from({ length: 20 }, (_, i) => ({
      serviceName: `S${i}`,
      params: { text: 'p'.repeat(600) },
      resultExcerpt: 'r'.repeat(600),
    }));
    const state = buildSpendCheckState(input({ earlier }));
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(16_000);
    expect(state.earlier_results.length).toBeLessThan(20);
    expect(state.earlier_results.length).toBeGreaterThan(0);
    expect(state.earlier_results.at(-1)?.service).toBe('S19');
    expect(state.earlier_results[0]?.service).toBe(`S${20 - state.earlier_results.length}`);
    // One fewer would not fit: the loop drops only as many as needed.
    const withOneMore = buildSpendCheckState(input({ earlier: earlier.slice(20 - state.earlier_results.length - 1) }));
    expect(withOneMore.earlier_results).toHaveLength(state.earlier_results.length);
  });

  it('never drops below no earlier results, even when the state stays over the cap', () => {
    const description = 'd'.repeat(17_000);
    const state = buildSpendCheckState(
      input({
        call: { serviceName: 'S', serviceDescription: description, params: {} },
        earlier: [{ serviceName: 'S', params: {}, resultExcerpt: 'r' }],
      }),
    );
    expect(state.earlier_results).toEqual([]);
    expect(state.proposed_call.description).toBe(description);
  });

  it('builds the excerpt from compact JSON, cut at 600 without a marker', () => {
    expect(resultExcerpt(undefined)).toBe('');
    expect(resultExcerpt({ a: 1 })).toBe('{"a":1}');
    expect(resultExcerpt('text')).toBe('"text"');
    expect(resultExcerpt({ s: 'x'.repeat(1000) })).toHaveLength(600);
  });
});

describe('applySpendPolicy', () => {
  const at = (servesTask: number, alreadyCovered: number) => ({ servesTask, alreadyCovered });

  it('uses strict comparisons at the thresholds', () => {
    const p = policy('enforce', 'enforce');
    expect(applySpendPolicy(at(0.4, 0.6), p)).toEqual({ outcome: 'pass' });
    expect(applySpendPolicy(at(0.39, 0.6), p)).toEqual({ outcome: 'block', rule: 'not_needed' });
    expect(applySpendPolicy(at(0.4, 0.61), p)).toEqual({ outcome: 'block', rule: 'already_covered' });
  });

  it.each([
    ['enforce', 'enforce', { outcome: 'block', rule: 'not_needed' }, { outcome: 'block', rule: 'already_covered' }, { outcome: 'block', rule: 'not_needed' }],
    ['enforce', 'observe', { outcome: 'block', rule: 'not_needed' }, { outcome: 'flag', rule: 'already_covered' }, { outcome: 'block', rule: 'not_needed' }],
    ['observe', 'enforce', { outcome: 'flag', rule: 'not_needed' }, { outcome: 'block', rule: 'already_covered' }, { outcome: 'block', rule: 'already_covered' }],
    ['observe', 'observe', { outcome: 'flag', rule: 'not_needed' }, { outcome: 'flag', rule: 'already_covered' }, { outcome: 'flag', rule: 'not_needed' }],
  ] as const)('modes %s/%s', (notNeeded, covered, onlyNotNeeded, onlyCovered, both) => {
    const p = policy(notNeeded, covered);
    expect(applySpendPolicy(at(0.1, 0.1), p)).toEqual(onlyNotNeeded);
    expect(applySpendPolicy(at(0.9, 0.9), p)).toEqual(onlyCovered);
    expect(applySpendPolicy(at(0.1, 0.9), p)).toEqual(both);
    expect(applySpendPolicy(at(0.9, 0.1), p)).toEqual({ outcome: 'pass' });
  });
});

function checker(check: SpendCheck['check']): SpendCheck {
  return { model: 'jev-test', check };
}

const result: SpendCheckResult = { model: 'jev-test', servesTask: 0.7, alreadyCovered: 0.1 };

describe('judgeSpendCheck', () => {
  it('returns a resolving checker result with the latency', async () => {
    const outcome = await judgeSpendCheck(checker(async () => result), input(), 1000);
    expect(outcome).toEqual({ ok: true, result, latencyMs: expect.any(Number) });
  });

  it('maps a SpendCheckError to its note, and any other error or a synchronous throw to "unexpected error"', async () => {
    expect(await judgeSpendCheck(checker(() => Promise.reject(new SpendCheckError('service error (HTTP 503)'))), input(), 1000)).toMatchObject({
      ok: false,
      note: 'service error (HTTP 503)',
    });
    expect(await judgeSpendCheck(checker(() => Promise.reject(new Error('boom'))), input(), 1000)).toMatchObject({ ok: false, note: 'unexpected error' });
    expect(
      await judgeSpendCheck(
        checker(() => {
          throw new Error('sync');
        }),
        input(),
        1000,
      ),
    ).toMatchObject({ ok: false, note: 'unexpected error' });
  });

  it('times out a checker that never settles, after at least the deadline', async () => {
    const outcome = await judgeSpendCheck(checker(() => new Promise<SpendCheckResult>(() => undefined)), input(), 30);
    expect(outcome).toMatchObject({ ok: false, note: 'timed out' });
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(30);
  });

  it('ignores a settlement after the deadline, with no unhandled rejection', async () => {
    let lateResolved = false;
    let lateRejected = false;
    const resolving = checker(async () => {
      await delay(80);
      lateResolved = true;
      return result;
    });
    const rejecting = checker(async () => {
      await delay(80);
      lateRejected = true;
      throw new SpendCheckError('service error (HTTP 500)');
    });
    expect(await judgeSpendCheck(resolving, input(), 30)).toMatchObject({ ok: false, note: 'timed out' });
    expect(await judgeSpendCheck(rejecting, input(), 30)).toMatchObject({ ok: false, note: 'timed out' });
    // Keep the test alive past the late settlements: Vitest fails on unhandled rejections.
    await delay(150);
    expect(lateResolved).toBe(true);
    expect(lateRejected).toBe(true);
  });

  it.each([
    ['above 1', { model: 'm', servesTask: 1.2, alreadyCovered: 0.1 }],
    ['NaN', { model: 'm', servesTask: 0.5, alreadyCovered: Number.NaN }],
    ['missing', { model: 'm', servesTask: 0.5 }],
    ['negative', { model: 'm', servesTask: -0.1, alreadyCovered: 0.1 }],
    ['not an object', null],
    ['model missing', { servesTask: 0.5, alreadyCovered: 0.1 }],
    ['model not a string', { model: 14, servesTask: 0.5, alreadyCovered: 0.1 }],
    ['model empty', { model: '', servesTask: 0.5, alreadyCovered: 0.1 }],
  ])('treats an out-of-range answer (%s) as "unexpected error"', async (_label, answer) => {
    const outcome = await judgeSpendCheck(checker(async () => answer as unknown as SpendCheckResult), input(), 1000);
    expect(outcome).toMatchObject({ ok: false, note: 'unexpected error' });
  });

  it('passes a signal that aborts at the deadline', async () => {
    let seen: AbortSignal | undefined;
    const outcome = await judgeSpendCheck(
      checker(
        (_input, signal) =>
          new Promise<SpendCheckResult>((_resolve, reject) => {
            seen = signal;
            signal.addEventListener('abort', () => reject(new SpendCheckError('aborted')));
          }),
      ),
      input(),
      30,
    );
    expect(seen?.aborted).toBe(true);
    // The deadline wins the race, whatever the implementation does on abort.
    expect(outcome).toMatchObject({ ok: false, note: 'timed out' });
  });

  it('defaults are as specified', () => {
    expect(CHECK_DEADLINE_MS).toBe(4000);
    expect(JEV_MODEL).toMatch(/^jev-1\.1[34]\.0$/);
  });
});

describe('describeDecisionLayer', () => {
  it.each([
    [{ on: true as const, model: 'jev-1.14.0', policy: policy('enforce', 'enforce') }, 'Decision layer: Jev (jev-1.14.0) on'],
    [{ on: true as const, model: 'jev-1.14.0', policy: policy('observe', 'enforce') }, 'Decision layer: Jev (jev-1.14.0) on, observe-only: not_needed'],
    [{ on: true as const, model: 'jev-1.14.0', policy: policy('enforce', 'observe') }, 'Decision layer: Jev (jev-1.14.0) on, observe-only: already_covered'],
    [
      { on: true as const, model: 'jev-1.13.0', policy: policy('observe', 'observe') },
      'Decision layer: Jev (jev-1.13.0) on, observe-only: not_needed, already_covered',
    ],
    [{ on: false as const, reason: '--no-spend-check' }, 'Decision layer: off (--no-spend-check)'],
    [{ on: false as const, reason: 'no TYPESAFE_API_KEY' }, 'Decision layer: off (no TYPESAFE_API_KEY)'],
    [{ on: false as const, reason: 'TypeSafe client setup failed' }, 'Decision layer: off (TypeSafe client setup failed)'],
  ])('%j', (state, line) => {
    expect(describeDecisionLayer(state)).toBe(line);
  });
});

describe('setupDecisionLayer', () => {
  const fake = checker(async () => result);

  it('builds the checker with the key and describes it with the default policy', () => {
    const keys: string[] = [];
    const setup = setupDecisionLayer({ want: true, apiKey: 'k1' }, ({ apiKey }) => {
      keys.push(apiKey);
      return fake;
    });
    expect(keys).toEqual(['k1']);
    expect(setup.spendCheck).toBe(fake);
    expect(setup.line).toBe(describeDecisionLayer({ on: true, model: 'jev-test', policy: DEFAULT_SPEND_POLICY }));
  });

  it('is off without calling the factory when not wanted, and off when the factory throws', () => {
    let called = false;
    const factory = () => {
      called = true;
      return fake;
    };
    expect(setupDecisionLayer({ want: false, reason: '--no-spend-check' }, factory)).toEqual({ line: 'Decision layer: off (--no-spend-check)' });
    expect(called).toBe(false);
    expect(
      setupDecisionLayer({ want: true, apiKey: 'k' }, () => {
        throw new Error('no key');
      }),
    ).toEqual({ line: 'Decision layer: off (TypeSafe client setup failed)' });
  });
});
