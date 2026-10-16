import { afterEach, describe, expect, it } from 'vitest';
import { exportPrivateKeyJwk, exportPrivateKeyRaw, generateAgentKey, publicKeyX } from '@payper402/scheme-paypal';
import { runCli } from './cli';
import { ConfigError, DEFAULT_TASK, loadAgentConfig, parseAgentKey } from './config';
import type { AgentEvent, SpendReport } from './events';
import { formatEvent, formatReport } from './format';
import { fakeAnthropic, message, startDemoEnv, toolUse, type Env } from './test-support';

const key = generateAgentKey();
const raw = exportPrivateKeyRaw(key.privateKey);

describe('agent configuration', () => {
  it('applies the defaults', () => {
    const config = loadAgentConfig({ AGENT_PRIVATE_KEY: raw });
    expect(config).toMatchObject({
      sellerUrl: 'http://localhost:4021',
      budgetCents: 100,
      maxPerCallCents: 10,
      model: 'claude-opus-5-5',
      task: DEFAULT_TASK,
    });
    expect(publicKeyX(config.privateKey)).toBe(key.publicKeyX);
  });

  it('parses --budget, --max-per-call and the task, over the environment', () => {
    const config = loadAgentConfig(
      { AGENT_PRIVATE_KEY: raw, AGENT_BUDGET: '5', AGENT_MAX_PER_CALL: '0.50', SELLER_URL: 'http://127.0.0.1:9999/' },
      ['--budget', '2.50', '--max-per-call', '$0.05', 'What', 'is', 'cocoa', 'doing?'],
    );
    expect(config).toMatchObject({ budgetCents: 250, maxPerCallCents: 5, task: 'What is cocoa doing?', sellerUrl: 'http://127.0.0.1:9999' });
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw, AGENT_BUDGET: '3.00' })).toMatchObject({ budgetCents: 300 });
  });

  it.each([
    [['--budget', 'lots'], '--budget must be a dollar amount'],
    [['--budget', '0'], '--budget must be a dollar amount'],
    [['--budget', '0.05', '--max-per-call', '0.10'], 'The per-call limit must not exceed the budget'],
    [['--unknown'], "Unknown option '--unknown'"],
  ])('rejects %j', (argv, messagePart) => {
    expect(() => loadAgentConfig({ AGENT_PRIVATE_KEY: raw }, argv)).toThrow(messagePart);
  });

  it('imports the key from a raw seed and from a JWK', () => {
    expect(publicKeyX(parseAgentKey(raw))).toBe(key.publicKeyX);
    expect(publicKeyX(parseAgentKey(JSON.stringify(exportPrivateKeyJwk(key.privateKey))))).toBe(key.publicKeyX);
  });

  it('rejects a bad key without echoing it', () => {
    const secret = 'not-a-key-but-secret';
    try {
      parseAgentKey(secret);
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).not.toContain(secret);
    }
    expect(() => parseAgentKey(JSON.stringify({ ...exportPrivateKeyJwk(key.privateKey), x: generateAgentKey().publicKeyX }))).toThrow(ConfigError);
  });
});

describe('runCli', () => {
  let env: Env | undefined;
  afterEach(async () => {
    await env?.close();
    env = undefined;
  });

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('exits 1 with a message when AGENT_PRIVATE_KEY is missing', async () => {
    const captured = io();
    expect(await runCli([], {}, captured.io)).toBe(1);
    expect(captured.err.join('\n')).toContain('AGENT_PRIVATE_KEY is required');
    expect(captured.out).toEqual([]);
  });

  it('exits 1 when the seller catalog cannot be loaded', async () => {
    const captured = io();
    expect(await runCli([], { AGENT_PRIVATE_KEY: raw, SELLER_URL: 'http://127.0.0.1:1' }, captured.io)).toBe(1);
    expect(captured.err.join('\n')).toContain('Could not reach the seller');
  });

  it('runs the agent, prints the timeline, the answer and the report, and exits 0', async () => {
    env = await startDemoEnv();
    const fake = fakeAnthropic([
      message([toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Price' })]),
      message([toolUse('finish', { answer: 'Coffee is up.', spend_explanation: 'One quote.' })]),
    ]);
    const captured = io();
    const code = await runCli(['--budget', '0.50'], { AGENT_PRIVATE_KEY: exportPrivateKeyRaw(env.key.privateKey), SELLER_URL: env.url }, captured.io, {
      anthropic: fake.client,
    });
    expect(code).toBe(0);
    const output = captured.out.join('\n');
    expect(output).toContain('[start] Acme Data: budget $0.50, per-call limit $0.10');
    expect(output).toContain('[402] call_1 Market Quote API asks $0.02 (catalog $0.02)');
    expect(output).toContain('[paid] call_1 Market Quote API $0.02');
    expect(output).toContain('[result] completed');
    expect(output).toContain('Coffee is up.');
    expect(output).toContain('Spend report (Acme Data)');
    expect(output).not.toContain(exportPrivateKeyRaw(env.key.privateKey));
  });
});

describe('format', () => {
  const base = { at: 1, callId: 'call_1', serviceId: 'quote', serviceName: 'Market Quote API' };
  const report: SpendReport = {
    sellerName: 'Acme Data',
    budgetCents: 100,
    spentCents: 7,
    uncertainCents: 0,
    remainingCents: 93,
    lines: [
      { serviceId: 'quote', serviceName: 'Market Quote API', calls: 1, unitPriceCents: 2, totalCents: 2 },
      { serviceId: 'summarize', serviceName: 'Page Summary API', calls: 1, unitPriceCents: 5, totalCents: 5 },
    ],
    notUsed: [{ serviceId: 'premium_news', serviceName: 'Premium News API', priceCents: 25 }],
    refusals: [{ serviceId: 'premium_news', code: 'over_per_call_limit' }],
    commitmentIds: ['cmt_1', 'cmt_2'],
    explanation: 'Bought a quote\nand a summary.',
  };
  const events: [AgentEvent, string][] = [
    [{ type: 'started', at: 1, sellerName: 'Acme Data', budgetCents: 100, maxPerCallCents: 10, task: 'Brief\nme' }, '[start] Acme Data: budget $1.00, per-call limit $0.10. Task: Brief me'],
    [{ type: 'thinking', at: 1, note: 'line one\nline two' }, '[think] line one line two'],
    [{ type: 'discovered_price', ...base, priceCents: 2, catalogPriceCents: 2 }, '[402] call_1 Market Quote API asks $0.02 (catalog $0.02)'],
    [{ type: 'decided', ...base, priceCents: 2, note: 'Need it', remainingCents: 98 }, '[decide] call_1 pay $0.02 for Market Quote API: Need it (left after this: $0.98)'],
    [
      { type: 'paid', ...base, amountCents: 2, commitmentId: 'cmt_1', httpStatus: 200, spentCents: 2, remainingCents: 98 },
      '[paid] call_1 Market Quote API $0.02, commitment cmt_1; spent $0.02, left $0.98',
    ],
    [
      { type: 'refused', ...base, code: 'wallet_revoked', by: 'facilitator', note: "Payment required: the operator's PayPal link was stopped." },
      "[refused] call_1 Market Quote API: Payment required: the operator's PayPal link was stopped. (wallet_revoked, by facilitator)",
    ],
    [{ type: 'failed', ...base, note: 'The payment outcome is unknown', charged: 'unknown' }, '[failed] call_1 Market Quote API: The payment outcome is unknown (charged: unknown)'],
    [{ type: 'failed', at: 1, note: 'The model request failed (HTTP 529)', charged: 'no' }, '[failed] The model request failed (HTTP 529) (charged: no)'],
    [{ type: 'result', at: 1, status: 'completed', answer: 'x', report }, '[result] completed'],
  ];

  it.each(events)('renders %j on one line', (event, expected) => {
    const line = formatEvent(event);
    expect(line).toBe(expected);
    expect(line).not.toContain('\n');
  });

  it('renders the report table', () => {
    expect(formatReport(report)).toBe(
      [
        'Spend report (Acme Data)',
        'Service           Calls   Unit           Total',
        'Market Quote API      1  $0.02           $0.02',
        'Page Summary API      1  $0.05           $0.05',
        'Spent                                    $0.07',
        'Left of budget                  $0.93 of $1.00',
        'Not used: Premium News API ($0.25)',
        'Refused: premium_news (over_per_call_limit)',
        'Commitments: cmt_1, cmt_2',
        'Why: Bought a quote and a summary.',
      ].join('\n'),
    );
  });
});
