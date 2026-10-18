import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASSET,
  BINDING_VERSION,
  ErrorCode,
  PAYPAL_SANDBOX_NETWORK,
  SCHEME,
  buildCommitment,
  generateAgentKey,
  importPrivateKeyJwk,
  kidFromPublicKeyX,
  signCommitment,
  type Ed25519PrivateJwk,
} from '@payper402/scheme-paypal';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { agentRef } from './views';
import { createHarness, T0, TEST_PEPPER, type Harness } from './test-support';

describe('operator API', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;

  beforeEach(() => {
    h = createHarness();
    ({ operatorId, key } = h.addOperator({ caps: { perCall: 10, daily: 100, unsettled: 50 } }));
  });
  afterEach(async () => {
    await h.close();
  });

  it('shows the overview', async () => {
    const agentId = h.addAgent(operatorId).agentId;
    h.addAgent(operatorId, { status: 'paused' });
    h.activateWallet(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 7 });
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 3, recordedAt: T0 - 86_400 });
    await h.services.settlements.settleManually(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 4 });
    const res = await h.api('GET', '/v1/operator', { key });
    expect(res.body).toMatchObject({
      operator: { id: operatorId, name: 'Test operator' },
      caps: { perCall: 10, daily: 100, unsettled: 50 },
      usage: { spentToday: 11, notYetCharged: 4, spentTotal: 14 },
      activeAgents: 1,
      wallet: { status: 'active', lastChargeAmount: 10, lastChargeStatus: 'completed', lastChargeAt: T0, linkError: null },
      lastSettlement: { status: 'completed', amount: 10, trigger: 'manual' },
    });
  });

  it('validates and sets caps', async () => {
    const ok = await h.api('PUT', '/v1/operator/caps', { key, body: { perCall: 5, daily: 500, unsettled: 20, total: 1000 } });
    expect(ok.status).toBe(200);
    expect(ok.body['caps']).toEqual({ perCall: 5, daily: 500, unsettled: 20, total: 1000 });
    const noTotal = await h.api('PUT', '/v1/operator/caps', { key, body: { perCall: 5, daily: 500, unsettled: 20, total: null } });
    expect(noTotal.body['caps']).toEqual({ perCall: 5, daily: 500, unsettled: 20 });
    for (const bad of [
      { perCall: 0, daily: 10, unsettled: 10 },
      { perCall: 11, daily: 10, unsettled: 20 },
      { perCall: 11, daily: 20, unsettled: 10 },
      { perCall: 5, daily: 10, unsettled: 10, total: 4 },
      { perCall: 1.5, daily: 10, unsettled: 10 },
      { perCall: -1, daily: 10, unsettled: 10 },
      { perCall: 5, daily: 10 },
      { perCall: 5, daily: 10, unsettled: 10, extra: 1 },
    ]) {
      const res = await h.api('PUT', '/v1/operator/caps', { key, body: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('rejects unknown fields on bodiless write endpoints', async () => {
    const res = await h.api('POST', '/v1/settlements', { key, body: { amount: 100 } });
    expect(res.status).toBe(400);
  });
});

describe('agents API', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;
  let sellerId: string;

  beforeEach(() => {
    h = createHarness();
    ({ operatorId, key } = h.addOperator({ caps: { perCall: 10, daily: 100, unsettled: 50 } }));
    sellerId = h.addSeller().sellerId;
  });
  afterEach(async () => {
    await h.close();
  });

  function verify(jwk: Ed25519PrivateJwk) {
    const privateKey = importPrivateKeyJwk(jwk);
    const req: PaymentRequirements = { scheme: SCHEME, network: PAYPAL_SANDBOX_NETWORK, asset: ASSET, amount: '5', payTo: sellerId, maxTimeoutSeconds: 300, extra: { version: BINDING_VERSION } };
    const commitment = buildCommitment({ kid: kidFromPublicKeyX(jwk.x), network: req.network, asset: ASSET, payTo: sellerId, maxAmount: '5', iat: T0, exp: T0 + 60 });
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: 'https://s.test/x' },
      accepted: req,
      payload: { commitment, signature: signCommitment(commitment, privateKey) },
    };
    return h.services.facilitator.verify(payload, req);
  }

  it('creates an agent with a generated key, returned once and never stored', async () => {
    const res = await h.api('POST', '/v1/agents', { key, body: { name: 'Shopper' } });
    expect(res.status).toBe(201);
    const agent = res.body['agent'] as Record<string, string>;
    const jwk = res.body['privateKeyJwk'] as Ed25519PrivateJwk;
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(agent).toMatchObject({ name: 'Shopper', status: 'active', createdAt: T0 });
    expect(agent['keyFingerprint']).toBe(`ed25519:${agent['kid']?.slice(0, 6)}${agent['kid']?.slice(-4)}`);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM agents').all())).not.toContain(jwk.d);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all())).not.toContain(jwk.d);
    const listed = await h.api('GET', `/v1/agents/${agent['id']}`, { key });
    expect(listed.body['privateKeyJwk']).toBeUndefined();
    expect(h.seen.find((e) => e.type === 'agent.updated')?.data).toEqual({ id: agent['id'], status: 'active' });
  });

  it('creates an agent with a supplied key, rejects bad keys and duplicates', async () => {
    const k = generateAgentKey();
    const res = await h.api('POST', '/v1/agents', { key, body: { name: 'Own key', publicKeyX: k.publicKeyX } });
    expect(res.status).toBe(201);
    expect(res.body['privateKeyJwk']).toBeUndefined();
    expect((res.body['agent'] as Record<string, string>)['kid']).toBe(k.kid);
    const dup = await h.api('POST', '/v1/agents', { key, body: { name: 'Again', publicKeyX: k.publicKeyX } });
    expect(dup.status).toBe(409);
    expect(dup.body['error']).toBe('agent_key_exists');
    const bad = await h.api('POST', '/v1/agents', { key, body: { name: 'Bad', publicKeyX: 'not-a-key' } });
    expect(bad.status).toBe(400);
    expect((await h.api('POST', '/v1/agents', { key, body: { name: '' } })).status).toBe(400);
    expect((await h.api('POST', '/v1/agents', { key, body: { name: 'x', admin: true } })).status).toBe(400);
  });

  it('pauses and resumes an agent; verify then gives agent_disabled', async () => {
    h.activateWallet(operatorId);
    const created = await h.api('POST', '/v1/agents', { key, body: { name: 'Shopper' } });
    const agent = created.body['agent'] as Record<string, string>;
    const jwk = created.body['privateKeyJwk'] as Ed25519PrivateJwk;
    expect(await verify(jwk)).toMatchObject({ isValid: true });
    const paused = await h.api('PATCH', `/v1/agents/${agent['id']}`, { key, body: { status: 'paused' } });
    expect(paused.body['agent']).toMatchObject({ status: 'paused' });
    expect(await verify(jwk)).toMatchObject({ isValid: false, invalidReason: ErrorCode.agentDisabled });
    await h.api('PATCH', `/v1/agents/${agent['id']}`, { key, body: { status: 'active', name: 'Renamed' } });
    expect(await verify(jwk)).toMatchObject({ isValid: true });
    expect(h.seen.filter((e) => e.type === 'agent.updated').map((e) => e.data['status'])).toEqual(['active', 'paused', 'active']);
    expect((await h.api('PATCH', `/v1/agents/${agent['id']}`, { key, body: {} })).status).toBe(400);
  });

  it('lists agents with usage and the derived blocked flag, scoped to the operator', async () => {
    const { agentId } = h.addAgent(operatorId);
    const other = h.addOperator();
    h.addAgent(other.operatorId);
    let res = await h.api('GET', '/v1/agents', { key });
    expect(res.body['agents']).toEqual([expect.objectContaining({ id: agentId, blocked: true, spentToday: 0, callsToday: 0, lastCallAt: null })]);
    h.activateWallet(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 10, recordedAt: T0 - 86_400 });
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 30 });
    res = await h.api('GET', '/v1/agents', { key });
    expect(res.body['agents']).toEqual([
      expect.objectContaining({ id: agentId, blocked: false, spentToday: 30, spentTotal: 40, callsToday: 1, lastCallAt: T0 }),
    ]);
    // 40 unsettled + a 10-cent max call reaches the 50 cap exactly; one more cent blocks.
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 1 });
    res = await h.api('GET', '/v1/agents', { key });
    expect((res.body['agents'] as { blocked: boolean }[])[0]?.blocked).toBe(true);
    expect((await h.api('GET', `/v1/agents/${agentId}`, { key: other.key })).status).toBe(404);
    expect((await h.api('PATCH', `/v1/agents/${agentId}`, { key: other.key, body: { status: 'paused' } })).status).toBe(404);
  });
});

describe('read APIs', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;
  let agentId: string;
  let seller: { sellerId: string; key: string };
  let otherSeller: { sellerId: string; key: string };

  beforeEach(() => {
    h = createHarness();
    ({ operatorId, key } = h.addOperator({ caps: { perCall: 50, daily: 1000, unsettled: 500 } }));
    agentId = h.addAgent(operatorId).agentId;
    seller = h.addSeller();
    otherSeller = h.addSeller();
    h.activateWallet(operatorId);
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists commitments newest first with filters, the path field and a before cursor', async () => {
    const ids = [0, 1, 2, 3, 4].map((i) =>
      h.addCommitment({ operatorId, agentId, payTo: i % 2 ? otherSeller.sellerId : seller.sellerId, amount: i + 1, recordedAt: T0 + i * 10, resourceUrl: `https://s.test/api/v${i}?q=${i}` }),
    );
    const all = await h.api('GET', '/v1/commitments', { key });
    const list = all.body['commitments'] as Record<string, unknown>[];
    expect(list.map((c) => c['id'])).toEqual([...ids].reverse());
    expect(list[0]).toEqual({
      id: ids[4],
      recordedAt: T0 + 40,
      agentId,
      agentName: 'Agent',
      payTo: seller.sellerId,
      resourceUrl: 'https://s.test/api/v4?q=4',
      path: '/api/v4?q=4',
      amount: 5,
      maxAmount: 5,
      state: 'unsettled',
      settlementId: null,
    });
    const page = await h.api('GET', `/v1/commitments?limit=2&before=${T0 + 30}`, { key });
    expect((page.body['commitments'] as { id: string }[]).map((c) => c.id)).toEqual([ids[2], ids[1]]);
    const window = await h.api('GET', `/v1/commitments?since=${T0 + 10}&until=${T0 + 30}`, { key });
    expect((window.body['commitments'] as { id: string }[]).map((c) => c.id)).toEqual([ids[2], ids[1]]);
    const byAgent = await h.api('GET', `/v1/commitments?agentId=nope`, { key });
    expect(byAgent.body['commitments']).toEqual([]);
    const byState = await h.api('GET', `/v1/commitments?state=settled`, { key });
    expect(byState.body['commitments']).toEqual([]);
    expect((await h.api('GET', '/v1/commitments?limit=501', { key })).status).toBe(400);
    expect((await h.api('GET', '/v1/commitments?state=bogus', { key })).status).toBe(400);
  });

  it('never shows another operator its data', async () => {
    h.addCommitment({ operatorId, agentId, payTo: seller.sellerId, amount: 5 });
    await h.services.settlements.settleManually(operatorId);
    const other = h.addOperator();
    expect((await h.api('GET', '/v1/commitments', { key: other.key })).body['commitments']).toEqual([]);
    expect((await h.api('GET', '/v1/settlements', { key: other.key })).body['settlements']).toEqual([]);
    const id = h.settlements(operatorId)[0]?.id;
    expect((await h.api('GET', `/v1/settlements/${id}`, { key: other.key })).status).toBe(404);
    expect((await h.api('GET', `/v1/settlements/${id}`, { key })).status).toBe(200);
  });

  it('lists settlements with a before cursor', async () => {
    for (let i = 0; i < 3; i += 1) {
      h.clock.now = T0 + i * 100;
      h.addCommitment({ operatorId, agentId, payTo: seller.sellerId, amount: 5 });
      await h.services.settlements.settleManually(operatorId);
    }
    const all = await h.api('GET', '/v1/settlements', { key });
    expect((all.body['settlements'] as { createdAt: number }[]).map((s) => s.createdAt)).toEqual([T0 + 200, T0 + 100, T0]);
    const page = await h.api('GET', `/v1/settlements?before=${T0 + 200}&limit=1`, { key });
    expect((page.body['settlements'] as { createdAt: number }[]).map((s) => s.createdAt)).toEqual([T0 + 100]);
  });

  it('shows sellers their own usage, calls and settlements with fee shares', async () => {
    h.addCommitment({ operatorId, agentId, payTo: seller.sellerId, amount: 30 });
    h.addCommitment({ operatorId, agentId, payTo: seller.sellerId, amount: 20, recordedAt: T0 - 86_400 });
    h.addCommitment({ operatorId, agentId, payTo: otherSeller.sellerId, amount: 50 });
    h.paypal.chargeScripts.push((input) => ({
      orderId: 'O',
      orderStatus: 'COMPLETED',
      capture: { id: 'C', status: 'COMPLETED', amountCents: input.amountCents, feeCents: 33, netCents: input.amountCents - 33 },
    }));
    await h.services.settlements.settleManually(operatorId);
    const other = h.addAgent(operatorId).agentId;
    h.addCommitment({ operatorId, agentId: other, payTo: seller.sellerId, amount: 7 });

    const overview = await h.api('GET', '/v1/seller', { key: seller.key });
    expect(overview.body).toEqual({
      seller: { id: seller.sellerId, name: 'Test seller', createdAt: T0 },
      usage: { revenueToday: 37, revenueTotal: 57, pending: 7, pendingCalls: 1, callsToday: 2, uniqueAgentsToday: 2 },
    });

    const calls = await h.api('GET', '/v1/seller/commitments', { key: seller.key });
    const list = calls.body['commitments'] as Record<string, unknown>[];
    expect(list).toHaveLength(3);
    expect(list.every((c) => c['payTo'] === seller.sellerId)).toBe(true);
    expect(list[0]).not.toHaveProperty('agentId');
    expect(list[0]).not.toHaveProperty('agentName');
    const latest = list.find((c) => c['amount'] === 7);
    expect(latest?.['agentRef']).toBe(agentRef(TEST_PEPPER, other));
    expect(String(latest?.['agentRef'])).toHaveLength(8);
    expect(new Set(list.map((c) => c['agentRef'])).size).toBe(2);
    expect(JSON.stringify(calls.body)).not.toContain(operatorId);
    expect(JSON.stringify(calls.body)).not.toContain(agentId);

    const settlements = await h.api('GET', '/v1/seller/settlements', { key: seller.key });
    // Fee 33 on a 100-cent batch: this seller's 50 cents carry round(33 * 50 / 100) = 17.
    expect(settlements.body['settlements']).toEqual([
      { id: h.settlements(operatorId)[0]?.id, createdAt: T0, status: 'completed', sellerAmount: 50, sellerCalls: 2, feeShare: 17, netShare: 33 },
    ]);
    expect(JSON.stringify(settlements.body)).not.toContain(operatorId);
    const otherView = await h.api('GET', '/v1/seller/settlements', { key: otherSeller.key });
    expect(otherView.body['settlements']).toEqual([expect.objectContaining({ sellerAmount: 50, sellerCalls: 1, feeShare: 17, netShare: 33 })]);
  });

  it('reports null fee shares until the fee is known', async () => {
    h.addCommitment({ operatorId, agentId, payTo: seller.sellerId, amount: 30 });
    h.paypal.chargeScripts.push(() => ({ orderId: 'O', orderStatus: 'COMPLETED', capture: { id: 'C', status: 'PENDING', amountCents: 30 } }));
    await h.services.settlements.settleManually(operatorId);
    const res = await h.api('GET', '/v1/seller/settlements', { key: seller.key });
    expect(res.body['settlements']).toEqual([expect.objectContaining({ status: 'pending', feeShare: null, netShare: null })]);
  });
});
