import { afterEach, describe, expect, it } from 'vitest';
import { exportPrivateKeyRaw, generateAgentKey } from '@payper402/scheme-paypal';
import { runCli } from './cli';
import { DEFAULT_SPEND_POLICY, describeDecisionLayer, type SpendCheck, type SpendCheckFactory } from './spend-check';
import { fakeAnthropic, message, startDemoEnv, toolUse, type Env } from './test-support';

const raw = exportPrivateKeyRaw(generateAgentKey().privateKey);
const UNREACHABLE = 'http://127.0.0.1:1';

const fakeChecker: SpendCheck = { model: 'jev-test', check: async () => ({ model: 'jev-test', servesTask: 0.9, alreadyCovered: 0.05 }) };

function recordingFactory(behaviour: 'ok' | 'throw' = 'ok') {
  const keys: string[] = [];
  const factory: SpendCheckFactory = ({ apiKey }) => {
    keys.push(apiKey);
    if (behaviour === 'throw') throw new Error('construction failed');
    return fakeChecker;
  };
  return { factory, keys };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe('runCli decision layer start-up line', () => {
  const onLine = describeDecisionLayer({ on: true, model: 'jev-test', policy: DEFAULT_SPEND_POLICY });

  it.each([
    ['on', [], { TYPESAFE_API_KEY: 'k-1' }, 'ok', onLine, ['k-1']],
    ['off with --no-spend-check and a key', ['--no-spend-check'], { TYPESAFE_API_KEY: 'k-1' }, 'ok', 'Decision layer: off (--no-spend-check)', []],
    ['off with --no-spend-check and no key', ['--no-spend-check'], {}, 'ok', 'Decision layer: off (--no-spend-check)', []],
    ['off with no key', [], {}, 'ok', 'Decision layer: off (no TYPESAFE_API_KEY)', []],
    ['off with a whitespace-only key', [], { TYPESAFE_API_KEY: '   ' }, 'ok', 'Decision layer: off (no TYPESAFE_API_KEY)', []],
    ['off when the factory throws', [], { TYPESAFE_API_KEY: 'k-1' }, 'throw', 'Decision layer: off (TypeSafe client setup failed)', ['k-1']],
  ] as const)('%s', async (_label, argv, vars, behaviour, line, keys) => {
    const captured = io();
    const recorder = recordingFactory(behaviour);
    const code = await runCli([...argv], { AGENT_PRIVATE_KEY: raw, SELLER_URL: UNREACHABLE, ...vars }, captured.io, {
      spendCheckFactory: recorder.factory,
      anthropic: fakeAnthropic([]).client,
    });
    expect(code).toBe(1);
    expect(captured.out).toEqual([line]);
    expect(recorder.keys).toEqual(keys);
  });

  it('passes the key to the factory trimmed', async () => {
    const recorder = recordingFactory();
    await runCli([], { AGENT_PRIVATE_KEY: raw, SELLER_URL: UNREACHABLE, TYPESAFE_API_KEY: '  k-trim \n' }, io().io, { spendCheckFactory: recorder.factory });
    expect(recorder.keys).toEqual(['k-trim']);
  });
});

describe('runCli with the decision layer on', () => {
  let env: Env | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });

  it('checks each paid call with the default policy and prints the summary line', async () => {
    env = await startDemoEnv();
    const fake = fakeAnthropic([
      message([toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Price' })]),
      message([toolUse('finish', { answer: 'Coffee is up.', spend_explanation: 'One quote.' })]),
    ]);
    const captured = io();
    const code = await runCli(
      ['--budget', '0.50'],
      { AGENT_PRIVATE_KEY: exportPrivateKeyRaw(env.key.privateKey), SELLER_URL: env.url, TYPESAFE_API_KEY: 'k-1' },
      captured.io,
      { anthropic: fake.client, spendCheckFactory: recordingFactory().factory },
    );
    expect(code).toBe(0);
    expect(captured.out[0]).toBe(describeDecisionLayer({ on: true, model: 'jev-test', policy: DEFAULT_SPEND_POLICY }));
    const decided = captured.out.filter((line) => line.startsWith('[decide]'));
    expect(decided).toEqual(['[decide] call_1 pay $0.02 for Market Quote API: Price (left after this: $0.48) | Jev: serves task 0.90, covered 0.05']);
    expect(captured.out.join('\n')).toContain('Decision layer: Jev (jev-test): 1 passed, 0 blocked, 0 flagged, 0 unavailable');
    expect(captured.out.join('\n')).not.toContain('k-1');
  });
});
