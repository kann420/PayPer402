import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateAgentKey, signAgentRequest, type AgentKey } from '@payper402/scheme-paypal';
import type { Logger } from './logger';
import { createHarness, T0, type Harness } from './test-support';

const PATH = '/v1/agent/status';

describe('GET /v1/agent/status', () => {
  let h: Harness;
  let logged: string[];
  let operatorId: string;
  let operatorKey: string;
  let sellerId: string;
  let agentId: string;
  let key: AgentKey;

  beforeEach(() => {
    logged = [];
    const record = (message: string, fields?: unknown) => {
      logged.push(`${message} ${JSON.stringify(fields ?? {})}`);
    };
    const logger: Logger = { debug: record, info: record, warn: record, error: record };
    h = createHarness({ logger });
    ({ operatorId, key: operatorKey } = h.addOperator({ caps: { perCall: 10, daily: 1000, unsettled: 500, total: 5000 } }));
    h.activateWallet(operatorId);
    sellerId = h.addSeller().sellerId;
    ({ agentId, key } = h.addAgent(operatorId));
  });
  afterEach(async () => {
    await h.close();
  });

  const header = (overrides: { iat?: number; method?: string; path?: string; as?: AgentKey } = {}) =>
    signAgentRequest({
      privateKey: (overrides.as ?? key).privateKey,
      kid: (overrides.as ?? key).kid,
      iat: overrides.iat ?? h.clock.now,
      method: overrides.method ?? 'GET',
      path: overrides.path ?? PATH,
    });
  const status = (authorization: string | null = header(), path = PATH) =>
    h.api('GET', path, { headers: authorization === null ? {} : { Authorization: authorization } });

  it('returns the least-privilege view, with the same figures as GET /v1/operator and GET /v1/agents', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 8 });
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 5, recordedAt: T0 - 86_400 });
    const other = h.addAgent(operatorId);
    h.addCommitment({ operatorId, agentId: other.agentId, payTo: sellerId, amount: 3 });

    const res = await status();
    expect(res.status).toBe(200);
    const body = res.body as {
      agent: Record<string, unknown>;
      operator: unknown;
      wallet: unknown;
      caps: unknown;
      usage: unknown;
    };
    const operatorView = (await h.api('GET', '/v1/operator', { key: operatorKey })).body as {
      operator: { name: string };
      wallet: Record<string, unknown>;
      caps: unknown;
      usage: Record<string, unknown>;
    };
    const agentRow = ((await h.api('GET', '/v1/agents', { key: operatorKey })).body['agents'] as Record<string, unknown>[]).find(
      (a) => a['id'] === agentId,
    ) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['agent', 'blockReason', 'blocked', 'caps', 'operator', 'remainingToday', 'usage', 'wallet']);
    expect(body.agent).toEqual({
      id: agentId,
      name: 'Agent',
      keyFingerprint: agentRow['keyFingerprint'],
      status: 'active',
      createdAt: T0,
      spentToday: 8,
      spentTotal: 13,
      callsToday: 1,
      lastCallAt: T0,
    });
    for (const field of ['id', 'name', 'keyFingerprint', 'status', 'createdAt', 'spentToday', 'spentTotal', 'callsToday', 'lastCallAt']) {
      expect(body.agent[field]).toEqual(agentRow[field]);
    }
    expect(body.operator).toEqual({ name: operatorView.operator.name });
    expect(body.caps).toEqual(operatorView.caps);
    expect(body.caps).toEqual({ perCall: 10, daily: 1000, unsettled: 500, total: 5000 });
    const { spentToday, notYetCharged, notYetChargedCalls, spentTotal } = operatorView.usage;
    expect(body.usage).toEqual({ spentToday, notYetCharged, notYetChargedCalls, spentTotal });
    expect(body.usage).toEqual({ spentToday: 11, notYetCharged: 16, notYetChargedCalls: 3, spentTotal: 16 });
    const { status: walletStatus, stoppedAt, lastChargeAt, lastChargeAmount, lastChargeStatus } = operatorView.wallet;
    expect(body.wallet).toEqual({ status: walletStatus, stoppedAt, lastChargeAt, lastChargeAmount, lastChargeStatus });
    expect(res.body['remainingToday']).toBe(989);
    expect(res.body['blocked']).toBe(false);
    expect(res.body['blockReason']).toBeNull();
  });

  it('omits caps.total when the operator has no total limit', async () => {
    h.db.prepare('UPDATE operators SET cap_total = NULL WHERE id = ?').run(operatorId);
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body['caps']).toEqual({ perCall: 10, daily: 1000, unsettled: 500 });
  });

  it('contains no operator id, no payer email, and nothing about other agents', async () => {
    const other = h.addAgent(operatorId);
    h.db.prepare(`UPDATE agents SET name = 'Hidden other agent' WHERE id = ?`).run(other.agentId);
    h.addCommitment({ operatorId, agentId: other.agentId, payTo: sellerId, amount: 3 });
    const res = await status();
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(operatorId);
    expect(text).not.toContain(other.agentId);
    expect(text).not.toContain('Hidden other agent');
    expect(text).not.toContain('payerEmailMasked');
    expect(text).not.toContain('bu***');
    expect(text).not.toContain(key.kid);
    expect(text).not.toContain('settlement');
  });

  it('answers 401 with one message for every kind of failure', async () => {
    const valid = header();
    const attempts: [string, string | null][] = [
      ['no header', null],
      ['a wrong scheme', valid.replace('PayPer402-Agent', 'Bearer')],
      ['a lower-case scheme', valid.replace('PayPer402-Agent', 'payper402-agent')],
      ['a bad signature', `${valid.slice(0, -4)}AAAA`],
      ['a truncated header', valid.slice(0, -10)],
      ['an unknown kid', header({ as: generateAgentKey() })],
      ['a stale iat', header({ iat: h.clock.now - 121 })],
      ['a future iat', header({ iat: h.clock.now + 121 })],
      ['another path', header({ path: '/v1/agent/other' })],
      ['another method', header({ method: 'POST' })],
    ];
    for (const [name, authorization] of attempts) {
      const res = await status(authorization);
      expect([name, res.status, res.body]).toEqual([name, 401, { error: 'unauthorized', message: 'Missing or invalid agent signature' }]);
    }
    expect((await h.api('GET', PATH, { key: operatorKey })).status).toBe(401);
  });

  it('accepts an iat exactly 120 seconds off, in either direction', async () => {
    expect((await status(header({ iat: h.clock.now - 120 }))).status).toBe(200);
    expect((await status(header({ iat: h.clock.now + 120 }))).status).toBe(200);
  });

  it('signs the path without the query', async () => {
    expect((await status(header(), `${PATH}?verbose=1`)).status).toBe(200);
  });

  it('signs the full path, not the part below the mount', async () => {
    expect((await status(header({ path: '/status' }))).status).toBe(401);
  });

  it('lets a paused agent read its status', async () => {
    h.db.prepare(`UPDATE agents SET status = 'paused' WHERE id = ?`).run(agentId);
    const res = await status();
    expect(res.status).toBe(200);
    expect((res.body['agent'] as { status: string }).status).toBe('paused');
    // `blocked` is the operator's, not the agent's own status.
    expect(res.body['blocked']).toBe(false);
  });

  it('reports a stopped wallet as blocked with wallet_not_active', async () => {
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer', stopped_at = ? WHERE operator_id = ?`).run(T0, operatorId);
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blocked: true, blockReason: 'wallet_not_active', wallet: { status: 'stopped_by_payer', stoppedAt: T0 } });
  });

  it.each([
    ['daily', 'UPDATE operators SET cap_daily = 20 WHERE id = ?'],
    ['unsettled', 'UPDATE operators SET cap_unsettled = 25 WHERE id = ?'],
    ['total', 'UPDATE operators SET cap_total = 25 WHERE id = ?'],
  ])('reports the %s cap as the block reason', async (reason, sql) => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 20 });
    h.db.prepare(sql).run(operatorId);
    const res = await status();
    expect(res.body).toMatchObject({ blocked: true, blockReason: reason });
  });

  it('never reports a negative remainingToday', async () => {
    for (let i = 0; i < 3; i++) h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 400 });
    const res = await status();
    expect((res.body['usage'] as { spentToday: number }).spentToday).toBe(1200);
    expect(res.body['remainingToday']).toBe(0);
  });

  it('answers 429 on the 61st request in a minute, counting refused ones', async () => {
    for (let i = 0; i < 59; i++) expect((await status()).status).toBe(200);
    expect((await h.api('GET', PATH)).status).toBe(401);
    const limited = await status();
    expect(limited.status).toBe(429);
    expect(limited.body['error']).toBe('too_many_requests');
    expect(limited.headers.get('retry-after')).toBe('60');
    h.clock.now = T0 + 61;
    expect((await status()).status).toBe(200);
  });

  it('logs neither the header nor the signature', async () => {
    const good = header();
    const bad = header({ path: '/v1/agent/other' });
    await status(good);
    await status(bad);
    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join('\n');
    for (const secret of [good, bad, good.split('.')[2] as string, bad.split('.')[2] as string]) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain('bad_signature');
  });
});
