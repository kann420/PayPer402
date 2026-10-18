import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { DEMO_OPERATOR_NAME } from './routes/admin';
import { apiError, createHarness, T0, type Harness } from './test-support';

const ADMIN_KEY = 'admin-key-admin-key-admin-key-0123456789';

let h: Harness;
afterEach(async () => {
  h.checkInvariants();
  await h.close();
});

describe('ADMIN_API_KEY', () => {
  const env = {
    PUBLIC_BASE_URL: 'http://localhost:4020',
    PAYPAL_CLIENT_ID: 'cid',
    PAYPAL_CLIENT_SECRET: 'secret',
    DATA_ENCRYPTION_KEY: '0f'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
  };

  it('is optional, and at least 32 characters when set; the error names only the variable', () => {
    h = createHarness();
    expect(loadConfig(env).adminApiKey).toBeUndefined();
    expect(loadConfig({ ...env, ADMIN_API_KEY: '  ' }).adminApiKey).toBeUndefined();
    expect(loadConfig({ ...env, ADMIN_API_KEY: ADMIN_KEY }).adminApiKey).toBe(ADMIN_KEY);
    let error: unknown;
    try {
      loadConfig({ ...env, ADMIN_API_KEY: 'short-secret-value' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('ADMIN_API_KEY');
    expect((error as ConfigError).message).not.toContain('short-secret-value');
  });
});

describe('POST /v1/admin/demo-operators', () => {
  it('is not mounted without ADMIN_API_KEY', async () => {
    h = createHarness();
    const res = await h.api('POST', '/v1/admin/demo-operators', { key: ADMIN_KEY, body: {} });
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('not_found');
  });

  it('refuses a missing or wrong key, and operator and seller keys', async () => {
    h = createHarness({ config: { adminApiKey: ADMIN_KEY } });
    const { key: operatorKey } = h.addOperator();
    const { key: sellerKey } = h.addSeller();
    expect((await h.api('POST', '/v1/admin/demo-operators', { body: {} })).status).toBe(401);
    expect((await h.api('POST', '/v1/admin/demo-operators', { key: `${ADMIN_KEY}x`, body: {} })).status).toBe(401);
    expect((await h.api('POST', '/v1/admin/demo-operators', { key: operatorKey, body: {} })).status).toBe(401);
    const seller = await h.api('POST', '/v1/admin/demo-operators', { key: sellerKey, body: {} });
    expect(seller.status).toBe(401);
    expect(seller.body['error']).toBe('unauthorized');
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM operators`).get()).toEqual({ n: 1 });
  });

  it('creates a demo operator with the demo caps, a not_linked wallet, a key and an audit record', async () => {
    h = createHarness({ config: { adminApiKey: ADMIN_KEY } });
    const res = await h.api('POST', '/v1/admin/demo-operators', { key: ADMIN_KEY, body: {} });
    expect(res.status).toBe(201);
    const operator = res.body['operator'] as { id: string; name: string };
    expect(operator.name).toBe(DEMO_OPERATOR_NAME);
    expect(operator.id).toMatch(/^op_/);
    const apiKey = res.body['apiKey'] as string;
    expect(apiKey).toMatch(/^pp402_op_[A-Za-z0-9_-]{43}$/);

    const view = await h.api('GET', '/v1/operator', { key: apiKey });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      operator: { id: operator.id, name: DEMO_OPERATOR_NAME, email: null },
      caps: { perCall: 10, daily: 1000, unsettled: 500, total: 5000 },
      wallet: { status: 'not_linked' },
      blockReason: 'wallet_not_active',
    });
    expect(h.db.prepare(`SELECT label FROM api_keys WHERE owner_id = ?`).get(operator.id)).toEqual({ label: 'web-demo' });
    expect(h.db.prepare(`SELECT actor_type, actor_id, action, resource_id FROM audit_log WHERE action = 'operator.demo_created'`).all()).toEqual([
      { actor_type: 'system', actor_id: 'admin', action: 'operator.demo_created', resource_id: operator.id },
    ]);
  });

  it('creates a new operator on every call, with an optional name', async () => {
    h = createHarness({ config: { adminApiKey: ADMIN_KEY } });
    const a = await h.api('POST', '/v1/admin/demo-operators', { key: ADMIN_KEY });
    const b = await h.api('POST', '/v1/admin/demo-operators', { key: ADMIN_KEY, body: { name: '  Judge one  ' } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body['operator'] as { id: string }).id).not.toBe((b.body['operator'] as { id: string }).id);
    expect((b.body['operator'] as { name: string }).name).toBe('Judge one');
    expect(a.body['apiKey']).not.toBe(b.body['apiKey']);
    for (const bad of [{ name: '' }, { name: 'x'.repeat(61) }, { other: 1 }]) {
      const res = await h.api('POST', '/v1/admin/demo-operators', { key: ADMIN_KEY, body: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('operator usage counts', () => {
  it('counts not-yet-charged calls in both states, and chargeable calls in unsettled only', async () => {
    h = createHarness();
    const { operatorId, key } = h.addOperator({ caps: { perCall: 25, daily: 1000, unsettled: 1000 } });
    const { agentId } = h.addAgent(operatorId);
    h.activateWallet(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 7 });
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 5 });
    // The first charge ends in needs_review: its two commitments stay `settling`.
    h.paypal.chargeScripts.push(() => {
      throw apiError(400, ['MALFORMED_REQUEST_JSON']);
    });
    await h.services.settlements.settleManually(operatorId);
    expect(h.settlements(operatorId)[0]?.status).toBe('needs_review');
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 3 });
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 2 });

    const res = await h.api('GET', '/v1/operator', { key });
    expect(res.body['usage']).toEqual({
      spentToday: 17,
      notYetCharged: 17,
      spentTotal: 17,
      notYetChargedCalls: 4,
      chargeable: 5,
      chargeableCalls: 2,
      notCollected: 0,
      notCollectedCalls: 0,
    });

    // A manual charge claims exactly `chargeable`.
    const charge = await h.api('POST', '/v1/settlements', { key });
    expect(charge.status).toBe(201);
    expect(charge.body['settlement']).toMatchObject({ status: 'completed', amount: 5, callsCount: 2, trigger: 'manual' });
    const after = await h.api('GET', '/v1/operator', { key });
    expect(after.body['usage']).toMatchObject({ notYetCharged: 12, notYetChargedCalls: 2, chargeable: 0, chargeableCalls: 0 });
  });

  it('counts not-collected calls after the payer stopped the agreement', async () => {
    h = createHarness();
    const { operatorId, key } = h.addOperator();
    const { agentId } = h.addAgent(operatorId);
    h.activateWallet(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 4 });
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 6 });
    h.paypal.chargeScripts.push(() => {
      throw apiError(422, ['AGREEMENT_ALREADY_CANCELLED']);
    });
    await h.services.settlements.settleManually(operatorId);
    const res = await h.api('GET', '/v1/operator', { key });
    expect(res.body['wallet']).toMatchObject({ status: 'stopped_by_payer' });
    expect(res.body['usage']).toMatchObject({
      notYetCharged: 0,
      notYetChargedCalls: 0,
      chargeable: 0,
      chargeableCalls: 0,
      notCollected: 10,
      notCollectedCalls: 2,
    });
    expect(res.body['blockReason']).toBe('wallet_not_active');
  });

  it('gives sellers the count of pending calls', async () => {
    h = createHarness();
    const { operatorId } = h.addOperator();
    const { agentId } = h.addAgent(operatorId);
    const { sellerId, key } = h.addSeller();
    h.activateWallet(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 4 });
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 6 });
    h.addCommitment({ operatorId, agentId, payTo: 'sel_other', amount: 9 });
    await h.services.settlements.settleManually(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 2 });
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 3 });
    const res = await h.api('GET', '/v1/seller', { key });
    expect(res.body['usage']).toMatchObject({ pending: 5, pendingCalls: 2, revenueTotal: 15 });
  });
});

describe('blockReason', () => {
  const reasons = async (key: string) => {
    const operator = await h.api('GET', '/v1/operator', { key });
    const agents = await h.api('GET', '/v1/agents', { key });
    const list = agents.body['agents'] as { id: string; blocked: boolean; blockReason: string | null }[];
    return { operator: operator.body['blockReason'], agents: list };
  };

  it('reports wallet_not_active, daily, unsettled, total and null, with blocked to match', async () => {
    h = createHarness();
    const setup = (caps: { perCall: number; daily: number; unsettled: number; total?: number }, active = true) => {
      const { operatorId, key } = h.addOperator({ caps });
      const { agentId } = h.addAgent(operatorId);
      if (active) h.activateWallet(operatorId);
      return { operatorId, agentId, key };
    };
    const notLinked = setup({ perCall: 10, daily: 100, unsettled: 50 }, false);
    expect(await reasons(notLinked.key)).toMatchObject({ operator: 'wallet_not_active', agents: [{ blocked: true, blockReason: 'wallet_not_active' }] });

    const daily = setup({ perCall: 10, daily: 100, unsettled: 1000, total: 5000 });
    expect(await reasons(daily.key)).toMatchObject({ operator: null, agents: [{ blocked: false, blockReason: null }] });
    h.addCommitment({ operatorId: daily.operatorId, agentId: daily.agentId, payTo: 'sel_a', amount: 95 });
    expect(await reasons(daily.key)).toMatchObject({ operator: 'daily', agents: [{ blocked: true, blockReason: 'daily' }] });

    const unsettled = setup({ perCall: 10, daily: 1000, unsettled: 50 });
    h.addCommitment({ operatorId: unsettled.operatorId, agentId: unsettled.agentId, payTo: 'sel_a', amount: 45 });
    expect(await reasons(unsettled.key)).toMatchObject({ operator: 'unsettled', agents: [{ blocked: true, blockReason: 'unsettled' }] });

    const total = setup({ perCall: 10, daily: 1000, unsettled: 1000, total: 200 });
    h.addCommitment({ operatorId: total.operatorId, agentId: total.agentId, payTo: 'sel_a', amount: 195, recordedAt: T0 - 2 * 86_400 });
    expect(await reasons(total.key)).toMatchObject({ operator: 'total', agents: [{ blocked: true, blockReason: 'total' }] });
  });

  it('a paused agent still reports the operator reason', async () => {
    h = createHarness();
    const { operatorId, key } = h.addOperator();
    h.addAgent(operatorId, { status: 'paused' });
    const r = await reasons(key);
    expect(r.agents[0]).toMatchObject({ status: 'paused', blocked: true, blockReason: 'wallet_not_active' });
    const one = await h.api('GET', `/v1/agents/${r.agents[0]?.id}`, { key });
    expect(one.body['agent']).toMatchObject({ blockReason: 'wallet_not_active' });
  });
});
