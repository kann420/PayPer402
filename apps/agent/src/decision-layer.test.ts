import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceDef } from '@payper402/demo-seller';
import type { AgentEvent } from './events';
import { openSession, type OpenSessionOptions } from './session';
import { SpendCheckError, type SpendCheck, type SpendCheckInput, type SpendCheckResult, type SpendPolicy } from './spend-check';
import { demoService, fetchSpy, startCustomEnv, startDemoEnv, type Env } from './test-support';
import { createToolCore } from './tools';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const TASK = 'Find me a quiet hotel in Kyoto near Gion for cherry blossom season, March 30 to April 2, 2027.';

const ENFORCE: SpendPolicy = { notNeededBelow: 0.4, coveredAbove: 0.6, modes: { not_needed: 'enforce', already_covered: 'enforce' } };
const OBSERVE: SpendPolicy = { ...ENFORCE, modes: { not_needed: 'observe', already_covered: 'observe' } };
const MIXED: SpendPolicy = { ...ENFORCE, modes: { not_needed: 'observe', already_covered: 'enforce' } };

const PASS: SpendCheckResult = { model: 'jev-1.14.0', servesTask: 0.8, alreadyCovered: 0.05 };
const NOT_NEEDED: SpendCheckResult = { model: 'jev-1.14.0', servesTask: 0.12, alreadyCovered: 0.05 };
const COVERED: SpendCheckResult = { model: 'jev-1.14.0', servesTask: 0.8, alreadyCovered: 0.91 };

interface FakeSpendCheck extends SpendCheck {
  inputs: SpendCheckInput[];
  calls: number;
}

function fakeSpendCheck(answer: (input: SpendCheckInput, signal: AbortSignal) => Promise<SpendCheckResult>): FakeSpendCheck {
  const fake: FakeSpendCheck = {
    model: 'jev-test',
    inputs: [],
    calls: 0,
    check(input, signal) {
      fake.calls += 1;
      fake.inputs.push(structuredClone(input));
      return answer(input, signal);
    },
  };
  return fake;
}

const always = (result: SpendCheckResult) => fakeSpendCheck(async () => result);

function sessionFor(e: Env, checker: SpendCheck | undefined, options: Partial<OpenSessionOptions> = {}, policy: SpendPolicy = ENFORCE, deadlineMs?: number) {
  return openSession({
    sellerUrl: e.url,
    privateKey: e.key.privateKey,
    budgetCents: 100,
    maxPerCallCents: 10,
    ...(checker === undefined ? {} : { spendCheck: { checker, task: TASK, policy, ...(deadlineMs === undefined ? {} : { deadlineMs }) } }),
    ...options,
  });
}

const types = (events: readonly AgentEvent[]) => events.map((e) => e.type);
const S = { city: 'kyoto', checkIn: '2027-03-30', checkOut: '2027-04-02' };
const GION = { ...S, area: 'gion' };
const HOTEL = { hotelId: 'gion-lantern-house' };

/** A custom paid route with one free-form param, answering the params back. */
function echoService(id: string, param: string, type: 'string' | 'integer' = 'string', priceCents = 1): ServiceDef {
  return {
    id,
    name: `Echo ${id}`,
    description: 'Echoes its params.',
    method: 'GET',
    path: `/v1/${id}`,
    priceCents,
    params: { [param]: type === 'string' ? { type: 'string', description: 'Any text', maxLength: 100 } : { type: 'integer', description: 'Any number' } },
    required: [param],
  };
}

describe('decision layer off', () => {
  it('keeps the Phase 3 events, with no check, and no report field', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env, undefined);
    let reservedAtDecided = -1;
    const observed = await openSession({
      sellerUrl: env.url,
      privateKey: env.key.privateKey,
      budgetCents: 100,
      maxPerCallCents: 10,
      onEvent: (event) => {
        if (event.type === 'decided') reservedAtDecided = observed.budget().reservedCents;
      },
    });
    expect(await session.call('hotel_search', S, 'Price')).toMatchObject({ ok: true });
    expect(await session.call('hotel_search', S, 'Price again')).toMatchObject({ ok: true });
    expect(types(session.events)).toEqual(['discovered_price', 'decided', 'paid', 'discovered_price', 'decided', 'paid']);
    for (const event of session.events) expect(event).not.toHaveProperty('check');
    expect(session.report()).not.toHaveProperty('decisionLayer');
    await observed.call('hotel_search', S, 'Price');
    // decided is emitted right after the reservation, as in Phase 3.
    expect(reservedAtDecided).toBe(2);
  });
});

describe('decision layer on', () => {
  it('pass: discovered_price, decided with the check, paid; the input has the task and description, no reason', async () => {
    env = await startDemoEnv();
    const checker = always(PASS);
    const session = await sessionFor(env, checker);
    expect(await session.call('hotel_search', S, 'SECRET-REASON need the price')).toMatchObject({ ok: true, paidCents: 2 });
    expect(types(session.events)).toEqual(['discovered_price', 'decided', 'paid']);
    expect(session.events[1]).toMatchObject({
      type: 'decided',
      note: 'SECRET-REASON need the price',
      check: { status: 'passed', model: 'jev-1.14.0', servesTask: 0.8, alreadyCovered: 0.05, latencyMs: expect.any(Number) },
    });
    expect(checker.inputs).toEqual([
      {
        task: TASK,
        call: { serviceName: 'Hotel Search API', serviceDescription: demoService('hotel_search').description, params: S },
        earlier: [],
      },
    ]);
    expect(JSON.stringify(checker.inputs)).not.toContain('SECRET-REASON');
  });

  it('passes earlier results: the search excerpt, at most 600 characters', async () => {
    env = await startDemoEnv();
    const checker = always(PASS);
    const session = await sessionFor(env, checker);
    const search = await session.call('hotel_search', S, 'Price');
    await session.call('review_summary', HOTEL, 'Reviews');
    const earlier = checker.inputs[1]?.earlier ?? [];
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).toMatchObject({ serviceName: 'Hotel Search API', params: S });
    expect(earlier[0]?.resultExcerpt.length).toBeLessThanOrEqual(600);
    expect(earlier[0]?.resultExcerpt).toBe(JSON.stringify(search.ok && search.data).slice(0, 600));
  });

  it('keeps the last 8 paid results as earlier results', async () => {
    env = await startCustomEnv([{ service: echoService('echo', 'q'), handler: (req, res) => void res.json({ q: req.query['q'] }) }]);
    const checker = always(PASS);
    const session = await sessionFor(env, checker);
    for (let i = 1; i <= 10; i += 1) expect(await session.call('echo', { q: `v${i}` }, 'Echo')).toMatchObject({ ok: true });
    const tenth = checker.inputs[9]?.earlier ?? [];
    expect(tenth).toHaveLength(8);
    expect(tenth.map((e) => e.params['q'])).toEqual(['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
    expect(tenth[0]?.resultExcerpt).toBe('{"q":"v2"}');
  });

  it.each([
    ['not_needed', NOT_NEEDED, { servesTask: 0.12, alreadyCovered: 0.05 }],
    ['already_covered', COVERED, { servesTask: 0.8, alreadyCovered: 0.91 }],
  ] as const)('%s block: refused with the check, reservation released, no paid request, not blocking', async (code, answer, scores) => {
    env = await startDemoEnv();
    const spy = fetchSpy();
    let next: SpendCheckResult = answer;
    const checker = fakeSpendCheck(async () => next);
    const session = await sessionFor(env, checker, { fetch: spy.fetch });
    const tools = createToolCore(session);
    const callService = tools.find((t) => t.name === 'call_service');
    const output = await callService?.run({ service_id: 'hotel_search', params: GION, reason: 'Gion hotels' });
    expect(output?.isError).toBe(true);
    const body = JSON.parse(output?.text ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'refused', code, check: scores });
    expect(Object.keys(body['check'] as object).sort()).toEqual(['alreadyCovered', 'servesTask']);
    expect(types(session.events)).toEqual(['discovered_price', 'refused']);
    expect(session.events[1]).toMatchObject({
      type: 'refused',
      code,
      by: 'agent',
      check: { status: 'blocked', model: 'jev-1.14.0', ...scores, latencyMs: expect.any(Number) },
    });
    expect(session.events[1]).not.toHaveProperty('detail');
    expect(session.budget()).toMatchObject({ remainingCents: 100, reservedCents: 0, spentCents: 0 });
    expect(spy.calls).toEqual([expect.objectContaining({ paid: false })]);
    expect(session.blocked).toBe(false);
    // A later, different call proceeds.
    next = PASS;
    expect(await session.call('hotel_search', S, 'Price')).toMatchObject({ ok: true });
    expect(env.ledger.size).toBe(1);
  });

  it('observe mode: decided with flagged and wouldRefuse, then paid', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env, always(NOT_NEEDED), {}, OBSERVE);
    expect(await session.call('hotel_search', GION, 'Gion hotels')).toMatchObject({ ok: true });
    expect(types(session.events)).toEqual(['discovered_price', 'decided', 'paid']);
    expect(session.events[1]).toMatchObject({ check: { status: 'flagged', wouldRefuse: 'not_needed', servesTask: 0.12 } });
    const covered = await sessionFor(env, always(COVERED), {}, OBSERVE);
    await covered.call('hotel_search', S, 'Price');
    expect(covered.events[1]).toMatchObject({ check: { status: 'flagged', wouldRefuse: 'already_covered', alreadyCovered: 0.91 } });
  });

  it('mixed policy: with both rules matching, an observed not_needed and an enforced already_covered block as already_covered', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env, always({ model: 'jev-1.14.0', servesTask: 0.1, alreadyCovered: 0.9 }), {}, MIXED);
    expect(await session.call('hotel_search', S, 'Price')).toMatchObject({ ok: false, code: 'already_covered' });
  });

  it('repeat: an exact retry of a blocked call gets the same refusal without asking Jev or reserving', async () => {
    env = await startDemoEnv();
    const checker = always(NOT_NEEDED);
    const reserved: number[] = [];
    const session = await sessionFor(env, checker, {
      onEvent: () => {
        reserved.push(session.budget().reservedCents);
      },
    });
    await session.call('hotel_search', GION, 'Gion hotels');
    reserved.length = 0;
    const repeat = await session.call('hotel_search', GION, 'Gion hotels, really');
    expect(repeat).toMatchObject({ ok: false, error: 'refused', code: 'not_needed', check: { servesTask: 0.12, alreadyCovered: 0.05 } });
    expect(checker.calls).toBe(1);
    expect(reserved.every((cents) => cents === 0)).toBe(true);
    const [first, second] = session.events.filter((e) => e.type === 'refused');
    expect(second).toMatchObject({ code: 'not_needed', by: 'agent', note: (first as { note: string }).note, detail: 'Same as call_1' });
    expect((second as { check: unknown }).check).toEqual({ ...(first as { check: object }).check, repeatOf: 'call_1' });
    // Changed params are judged anew.
    await session.call('hotel_search', { ...S, area: 'higashiyama' }, 'Higashiyama hotels');
    expect(checker.calls).toBe(2);
  });

  it('duplicate of a paid call: duplicate_call "(paid)" without asking Jev', async () => {
    env = await startDemoEnv();
    const checker = always(PASS);
    const session = await sessionFor(env, checker);
    await session.call('hotel_search', S, 'Price');
    const outcome = await session.call('hotel_search', S, 'Price again');
    expect(outcome).toMatchObject({ ok: false, error: 'refused', code: 'duplicate_call', message: 'This exact call was already made in this run' });
    expect(outcome).not.toHaveProperty('check');
    expect(checker.calls).toBe(1);
    const refused = session.events.at(-1);
    expect(refused).toMatchObject({ type: 'refused', code: 'duplicate_call', by: 'agent', detail: 'Same as call_1 (paid)' });
    expect(refused).not.toHaveProperty('check');
    expect(session.budget()).toMatchObject({ spentCents: 2, reservedCents: 0 });
  });

  it('duplicate of an in-flight call: "(in progress)", then the first call pays', async () => {
    env = await startDemoEnv();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checker = fakeSpendCheck(async () => {
      entered();
      await gate;
      return PASS;
    });
    const session = await sessionFor(env, checker);
    const first = session.call('hotel_search', S, 'Price');
    await enteredPromise;
    const second = await session.call('hotel_search', S, 'Price, in parallel');
    expect(second).toMatchObject({ ok: false, code: 'duplicate_call' });
    expect(session.events.find((e) => e.type === 'refused')).toMatchObject({ callId: 'call_2', detail: 'Same as call_1 (in progress)' });
    release();
    expect(await first).toMatchObject({ ok: true, paidCents: 2 });
    expect(checker.calls).toBe(1);
  });

  it('duplicate of an uncertain call: "(outcome unknown)"', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy((res, init) => {
      if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) throw new TypeError('socket hang up');
      return res;
    });
    const session = await sessionFor(env, always(PASS), { fetch: spy.fetch });
    expect(await session.call('hotel_search', S, 'Price')).toMatchObject({ ok: false, error: 'failed' });
    expect(session.budget().uncertainCents).toBe(2);
    expect(await session.call('hotel_search', S, 'Price')).toMatchObject({ code: 'duplicate_call' });
    expect(session.events.at(-1)).toMatchObject({ detail: 'Same as call_1 (outcome unknown)' });
  });

  it('a call closed with charged "no" may be retried, and reaches the checker again', async () => {
    env = await startCustomEnv([{ service: echoService('bad', 'q'), handler: (_req, res) => void res.status(400).json({ error: 'validation_failed' }) }]);
    const checker = always(PASS);
    const session = await sessionFor(env, checker);
    expect(await session.call('bad', { q: 'x' }, 'Try')).toMatchObject({ ok: false, error: 'failed' });
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'no' });
    expect(await session.call('bad', { q: 'x' }, 'Retry')).toMatchObject({ ok: false, error: 'failed' });
    expect(checker.calls).toBe(2);
    expect(session.events.filter((e) => e.type === 'refused')).toEqual([]);
  });

  describe('unavailable (fail-open)', () => {
    it.each([
      ['a SpendCheckError', () => Promise.reject(new SpendCheckError('service error (HTTP 503)')), 'service error (HTTP 503)', undefined],
      ['a checker that never settles', () => new Promise<SpendCheckResult>(() => undefined), 'timed out', 30],
      [
        'a synchronous throw',
        () => {
          throw new Error('sync');
        },
        'unexpected error',
        undefined,
      ],
    ])('%s: decided with unavailable, then paid', async (_label, answer, note, deadlineMs) => {
      env = await startDemoEnv();
      const session = await sessionFor(env, fakeSpendCheck(answer as () => Promise<SpendCheckResult>), {}, ENFORCE, deadlineMs);
      expect(await session.call('hotel_search', S, 'Price')).toMatchObject({ ok: true });
      expect(types(session.events)).toEqual(['discovered_price', 'decided', 'paid']);
      expect(session.events[1]).toMatchObject({ check: { status: 'unavailable', note, latencyMs: expect.any(Number) } });
      expect(Object.keys((session.events[1] as { check: object }).check).sort()).toEqual(['latencyMs', 'note', 'status']);
    });
  });

  it('budget safety: 20 parallel distinct calls with a slow checker and room for 7 pay exactly 7', async () => {
    env = await startCustomEnv([{ service: echoService('n', 'n', 'integer', 2), handler: (req, res) => void res.json({ n: req.query['n'] }) }]);
    const checker = fakeSpendCheck(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return PASS;
    });
    let lowest = Number.POSITIVE_INFINITY;
    const session = await sessionFor(env, checker, {
      budgetCents: 14,
      maxPerCallCents: 2,
      onEvent: () => {
        lowest = Math.min(lowest, session.budget().remainingCents);
      },
    });
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => session.call('n', { n: i }, 'Number')));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(7);
    expect(session.events.filter((e) => e.type === 'paid')).toHaveLength(7);
    expect(env.ledger.size).toBe(7);
    expect(session.budget()).toMatchObject({ spentCents: 14, remainingCents: 0, reservedCents: 0 });
    expect(lowest).toBeGreaterThanOrEqual(0);
  });

  it('report: decisionLayer with the model, the modes and counts from the events; JSON round-trips', async () => {
    env = await startDemoEnv();
    const answers: (SpendCheckResult | 'fail')[] = [PASS, NOT_NEEDED, NOT_NEEDED, 'fail'];
    const checker = fakeSpendCheck(async () => {
      const next = answers.shift() ?? PASS;
      if (next === 'fail') throw new SpendCheckError('connection failed');
      return next;
    });
    const session = await sessionFor(env, checker, {}, MIXED);
    await session.call('hotel_search', S, 'Price'); // passed
    await session.call('hotel_search', GION, 'Gion hotels'); // flagged (not_needed observes)
    await session.call('hotel_search', { ...S, area: 'higashiyama' }, 'Higashiyama hotels'); // flagged
    await session.call('hotel_search', { ...S, area: 'kawaramachi' }, 'Kawaramachi hotels'); // unavailable
    await session.call('hotel_search', S, 'Price again'); // duplicate_call, not counted
    const blocking = await sessionFor(env, always(COVERED), {}, MIXED);
    await blocking.call('hotel_search', S, 'Price'); // blocked
    await blocking.call('hotel_search', S, 'Price'); // blocked repeat
    const report = session.report('Why');
    expect(report.decisionLayer).toEqual({
      model: 'jev-test',
      modes: { not_needed: 'observe', already_covered: 'enforce' },
      passed: 1,
      blocked: 0,
      flagged: 2,
      unavailable: 1,
    });
    expect(report.refusals).toEqual([{ serviceId: 'hotel_search', code: 'duplicate_call' }]);
    expect(blocking.report().decisionLayer).toMatchObject({ passed: 0, blocked: 2, flagged: 0, unavailable: 0 });
    for (const event of [...session.events, ...blocking.events]) expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
