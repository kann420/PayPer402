/**
 * Shared payment tokens and the payment-token step of finishing a link (design spec §5.1, §8
 * step 2, §9.3, §10, §11, §12; build spec Phase 4, Milestone 11). Fake PayPal only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargeVaultedWalletInput } from '@payper402/paypal-client';
import { apiError, createHarness, networkError, T0, type Harness } from './test-support';

const SHARED = 'PT-S';

let h: Harness;
beforeEach(() => {
  h = createHarness({ config: { webAppUrl: 'https://app.test' } });
});
afterEach(async () => {
  h.checkInvariants();
  await h.close();
});

function webhook(event: Record<string, unknown>) {
  return h.api('POST', '/webhooks/paypal', { headers: { 'paypal-transmission-sig': 'valid', 'paypal-transmission-id': 'tx' }, body: event });
}

/** Starts a link for the operator and approves its setup token at the fake PayPal. Returns the state. */
async function startAndApprove(operatorId: string, key: string): Promise<string> {
  expect((await h.api('POST', '/v1/operator/wallet/link', { key })).status).toBe(200);
  const wallet = h.wallet(operatorId);
  h.paypal.approve(wallet.setup_token_id ?? '');
  return wallet.link_state ?? '';
}

/** Links through the browser return; returns the redirect's status. */
async function link(operatorId: string, key: string): Promise<string | null> {
  const state = await startAndApprove(operatorId, key);
  const res = await h.api('GET', `/paypal/return?state=${state}`);
  return new URL(res.headers.get('location') ?? 'https://x.test').searchParams.get('status');
}

/** An operator with an agent, optionally holding a stored token in the given status. */
function operator(token?: string, status: 'active' | 'stopped_by_payer' | 'waiting_for_approval' = 'active') {
  const { operatorId, key } = h.addOperator();
  const { agentId } = h.addAgent(operatorId);
  if (token !== undefined) {
    h.activateWallet(operatorId, token);
    if (status !== 'active') h.db.prepare('UPDATE wallets SET status = ? WHERE operator_id = ?').run(status, operatorId);
  }
  return { operatorId, key, agentId };
}

const opened = (operatorId: string) => h.services.ctx.box.open(h.wallet(operatorId).vault_id_sealed ?? '');
const audits = (action: string) =>
  h.db.prepare('SELECT actor_type, resource_id, details FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
    actor_type: string;
    resource_id: string;
    details: string | null;
  }[];
const walletEvents = () => h.seen.filter((e) => e.type === 'wallet.updated').map((e) => ({ operatorId: e.operatorId, ...(e.data as object) }));

describe('shared link', () => {
  it('two operators link the same payer: both active with one token, and each settles on its own', async () => {
    h.paypal.existingPaymentToken = SHARED;
    const a = operator();
    const b = operator();
    expect(await link(a.operatorId, a.key)).toBe('active');
    expect(await link(b.operatorId, b.key)).toBe('active');
    for (const op of [a, b]) {
      expect(h.wallet(op.operatorId)).toMatchObject({ status: 'active', payer_email_masked: 'bu***@example.com' });
      expect(opened(op.operatorId)).toBe(SHARED);
    }
    expect(h.wallet(a.operatorId).vault_id_hash).toBe(h.wallet(b.operatorId).vault_id_hash);

    const seller = h.addSeller().sellerId;
    h.addCommitment({ operatorId: a.operatorId, agentId: a.agentId, payTo: seller, amount: 7 });
    h.addCommitment({ operatorId: b.operatorId, agentId: b.agentId, payTo: seller, amount: 11 });
    await h.services.settlements.settleManually(a.operatorId);
    await h.services.settlements.settleManually(b.operatorId);
    const charges = h.paypal.callsOf('chargeVaultedWallet').map((args) => args[0] as ChargeVaultedWalletInput);
    expect(charges.map((c) => [c.vaultId, c.amountCents])).toEqual([
      [SHARED, 7],
      [SHARED, 11],
    ]);
    expect(new Set(charges.map((c) => c.requestId)).size).toBe(2);
    expect(h.settlements(a.operatorId)).toEqual([expect.objectContaining({ status: 'completed', amount: 7 })]);
    expect(h.settlements(b.operatorId)).toEqual([expect.objectContaining({ status: 'completed', amount: 11 })]);
    h.checkInvariants();
  });
});

describe('revoking a shared token', () => {
  it('VAULT.PAYMENT-TOKEN.DELETED revokes every holder', async () => {
    const a = operator(SHARED);
    const b = operator(SHARED);
    h.addCommitment({ operatorId: a.operatorId, agentId: a.agentId, payTo: 'sel_x', amount: 3 });
    h.addCommitment({ operatorId: b.operatorId, agentId: b.agentId, payTo: 'sel_x', amount: 4 });
    expect((await webhook({ id: 'WH-S', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: SHARED } })).status).toBe(200);
    expect(h.wallet(a.operatorId).status).toBe('stopped_by_payer');
    expect(h.wallet(b.operatorId).status).toBe('stopped_by_payer');
    expect(h.commitmentStates(a.operatorId)).toEqual({ uncollectable: 1 });
    expect(h.commitmentStates(b.operatorId)).toEqual({ uncollectable: 1 });
    expect(walletEvents()).toEqual(
      expect.arrayContaining([
        { operatorId: a.operatorId, status: 'stopped_by_payer' },
        { operatorId: b.operatorId, status: 'stopped_by_payer' },
      ]),
    );
    expect(walletEvents()).toHaveLength(2);
    expect(audits('wallet.revoked').map((r) => [r.resource_id, r.details])).toEqual(
      expect.arrayContaining([
        [a.operatorId, '{"via":"webhook"}'],
        [b.operatorId, '{"via":"webhook"}'],
      ]),
    );
    expect(h.db.prepare('SELECT outcome FROM webhook_events').get()).toEqual({ outcome: 'wallet_revoked' });
  });

  it('answers wallet_not_found when no wallet holds the token', async () => {
    operator(SHARED);
    await webhook({ id: 'WH-N', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'PT-NOBODY' } });
    expect(h.db.prepare('SELECT outcome FROM webhook_events').get()).toEqual({ outcome: 'wallet_not_found' });
  });

  it('answers wallet_not_revocable when holders exist but none is active or unlinking', async () => {
    const a = operator(SHARED, 'stopped_by_payer');
    const b = operator(SHARED, 'waiting_for_approval');
    await webhook({ id: 'WH-R', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: SHARED } });
    expect(h.db.prepare('SELECT outcome FROM webhook_events').get()).toEqual({ outcome: 'wallet_not_revocable' });
    expect(h.wallet(a.operatorId).status).toBe('stopped_by_payer');
    expect(h.wallet(b.operatorId).status).toBe('waiting_for_approval');
    expect(walletEvents()).toEqual([]);
  });

  it("a 404 on A's health check revokes A and B; only A's last_checked_at is written", async () => {
    const a = operator(SHARED);
    const b = operator(SHARED);
    h.db.prepare('UPDATE wallets SET last_checked_at = ? WHERE operator_id = ?').run(T0 - 5, b.operatorId);
    h.paypal.paymentTokens.delete(SHARED);
    await h.services.jobs.runTick();
    expect(h.wallet(a.operatorId)).toMatchObject({ status: 'stopped_by_payer', stopped_at: T0, last_checked_at: T0 });
    expect(h.wallet(b.operatorId)).toMatchObject({ status: 'stopped_by_payer', stopped_at: T0, last_checked_at: T0 - 5 });
    expect(audits('wallet.revoked').map((r) => r.details)).toEqual(['{"via":"health_check"}', '{"via":"health_check"}']);
  });

  it('a holder revoked earlier in the same tick is not checked again', async () => {
    const a = operator(SHARED);
    const b = operator(SHARED);
    h.paypal.paymentTokens.delete(SHARED);
    await h.services.jobs.runTick();
    expect(h.paypal.callsOf('getPaymentToken')).toHaveLength(1);
    const checked = [h.wallet(a.operatorId).last_checked_at, h.wallet(b.operatorId).last_checked_at];
    expect(checked.filter((v) => v === T0)).toHaveLength(1);
    expect(checked.filter((v) => v === null)).toHaveLength(1);
    expect([h.wallet(a.operatorId).status, h.wallet(b.operatorId).status]).toEqual(['stopped_by_payer', 'stopped_by_payer']);
  });

  it("a revocation-class error on A's settlement also revokes B", async () => {
    const a = operator(SHARED);
    const b = operator(SHARED);
    h.addCommitment({ operatorId: a.operatorId, agentId: a.agentId, payTo: 'sel_x', amount: 5 });
    h.addCommitment({ operatorId: b.operatorId, agentId: b.agentId, payTo: 'sel_x', amount: 6 });
    h.paypal.chargeScripts.push(() => {
      throw apiError(422, ['AGREEMENT_ALREADY_CANCELLED']);
    });
    const settlement = await h.services.settlements.settleManually(a.operatorId);
    expect(settlement).toMatchObject({ status: 'failed', failure_code: 'payer_stopped' });
    expect(h.wallet(a.operatorId).status).toBe('stopped_by_payer');
    expect(h.wallet(b.operatorId).status).toBe('stopped_by_payer');
    expect(h.commitmentStates(a.operatorId)).toEqual({ uncollectable: 1 });
    expect(h.commitmentStates(b.operatorId)).toEqual({ uncollectable: 1 });
    expect(walletEvents()).toHaveLength(2);
    expect(audits('wallet.revoked').map((r) => [r.resource_id, JSON.parse(r.details ?? '{}')])).toEqual(
      expect.arrayContaining([
        [a.operatorId, { via: 'charge_error', settlementId: settlement.id }],
        [b.operatorId, { via: 'charge_error', settlementId: settlement.id }],
      ]),
    );
  });

  it("a revocation-class error on A's relink: A link_failed, B revoked, then the token is deleted", async () => {
    const b = operator(SHARED);
    const a = operator();
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer' WHERE operator_id = ?`).run(a.operatorId);
    const debt = h.addCommitment({ operatorId: a.operatorId, agentId: a.agentId, payTo: 'sel_x', amount: 9, state: 'uncollectable' });
    h.paypal.existingPaymentToken = SHARED;
    h.paypal.chargeScripts.push(() => {
      throw apiError(422, ['AGREEMENT_ALREADY_CANCELLED']);
    });
    expect(await link(a.operatorId, a.key)).toBe('link_failed');
    const [settlement] = h.settlements(a.operatorId);
    expect(settlement).toMatchObject({ trigger: 'relink', status: 'failed', failure_code: 'payer_stopped' });
    expect(h.wallet(a.operatorId)).toMatchObject({
      status: 'link_failed',
      link_error: 'relink_settlement_failed',
      vault_id_sealed: null,
      vault_id_hash: null,
    });
    expect(h.wallet(b.operatorId).status).toBe('stopped_by_payer');
    expect(h.paypal.deletedTokens).toEqual([SHARED]);
    expect(audits('wallet.token_kept_shared')).toEqual([]);
    expect(h.db.prepare('SELECT state, settlement_id FROM commitments WHERE id = ?').get(debt)).toEqual({
      state: 'uncollectable',
      settlement_id: settlement?.id,
    });
  });
});

describe('releasing a shared token', () => {
  it('unlinking A while B is active keeps the token; B still settles; unlinking B deletes it once', async () => {
    const a = operator(SHARED);
    const b = operator(SHARED);
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key: a.key });
    expect(res.status).toBe(200);
    expect(h.wallet(a.operatorId)).toMatchObject({ status: 'not_linked', vault_id_sealed: null, vault_id_hash: null });
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(audits('wallet.token_kept_shared')).toEqual([{ actor_type: 'system', resource_id: a.operatorId, details: null }]);

    h.addCommitment({ operatorId: b.operatorId, agentId: b.agentId, payTo: 'sel_x', amount: 8 });
    expect(await h.services.settlements.settleManually(b.operatorId)).toMatchObject({ status: 'completed', amount: 8 });

    expect((await h.api('POST', '/v1/operator/wallet/unlink', { key: b.key })).status).toBe(200);
    expect(h.paypal.deletedTokens).toEqual([SHARED]);
    expect(h.wallet(b.operatorId).status).toBe('not_linked');
  });

  it('startLink with a stored token skips the DELETE while another live holder exists', async () => {
    const a = operator(SHARED, 'stopped_by_payer');
    operator(SHARED);
    expect((await h.api('POST', '/v1/operator/wallet/link', { key: a.key })).status).toBe(200);
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(audits('wallet.token_kept_shared').map((r) => r.resource_id)).toEqual([a.operatorId]);
    expect(h.wallet(a.operatorId)).toMatchObject({ status: 'waiting_for_approval', vault_id_sealed: null, vault_id_hash: null });
  });

  it('a holder in stopped_by_payer does not count as live', async () => {
    const a = operator(SHARED, 'stopped_by_payer');
    operator(SHARED, 'stopped_by_payer');
    expect((await h.api('POST', '/v1/operator/wallet/link', { key: a.key })).status).toBe(200);
    expect(h.paypal.deletedTokens).toEqual([SHARED]);
    expect(audits('wallet.token_kept_shared')).toEqual([]);
  });

  it("finish's lost-race path skips the DELETE while another live holder exists", async () => {
    operator(SHARED);
    const a = operator();
    h.paypal.existingPaymentToken = SHARED;
    await startAndApprove(a.operatorId, a.key);
    const hold = h.paypal.hold('createPaymentToken');
    const refresh = h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    await hold.entered;
    expect((await h.api('POST', '/v1/operator/wallet/link', { key: a.key })).status).toBe(200);
    hold.release();
    expect((await refresh).body['wallet']).toMatchObject({ status: 'waiting_for_approval' });
    expect(h.wallet(a.operatorId).vault_id_hash).toBeNull();
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(audits('wallet.token_kept_shared').map((r) => r.resource_id)).toEqual([a.operatorId]);
  });

  it("a waiting holder is live: unlinking A keeps the token, and B's relink then charges and completes", async () => {
    const a = operator(SHARED);
    const b = operator();
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer' WHERE operator_id = ?`).run(b.operatorId);
    h.addCommitment({ operatorId: b.operatorId, agentId: b.agentId, payTo: 'sel_x', amount: 9, state: 'uncollectable' });
    h.paypal.existingPaymentToken = SHARED;
    h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    expect(await link(b.operatorId, b.key)).toBe('waiting_for_approval');
    expect(h.settlements(b.operatorId)).toEqual([expect.objectContaining({ trigger: 'relink', status: 'pending', attempts: 1 })]);
    expect(opened(b.operatorId)).toBe(SHARED);

    expect((await h.api('POST', '/v1/operator/wallet/unlink', { key: a.key })).status).toBe(200);
    expect(h.wallet(a.operatorId).status).toBe('not_linked');
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(audits('wallet.token_kept_shared').map((r) => r.resource_id)).toEqual([a.operatorId]);

    h.clock.now += 30;
    await h.services.jobs.runTick();
    expect(h.settlements(b.operatorId)).toEqual([expect.objectContaining({ trigger: 'relink', status: 'completed', amount: 9 })]);
    expect(h.wallet(b.operatorId).status).toBe('active');
    expect(h.commitmentStates(b.operatorId)).toEqual({ settled: 1 });
  });
});

describe('finishing a link: the payment-token step', () => {
  it('VAULTED resumes the link: the payment token is created again with request id = state', async () => {
    const a = operator();
    const state = await startAndApprove(a.operatorId, a.key);
    // An earlier attempt created the token, but its result was never stored.
    const lost = await h.paypal.createPaymentToken('ST-1', state);
    expect(h.paypal.setupTokens.get('ST-1')).toBe('VAULTED');
    const res = await h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    expect(res.status).toBe(200);
    expect(res.body['wallet']).toMatchObject({ status: 'active' });
    expect(h.paypal.callsOf('createPaymentToken')).toEqual([
      ['ST-1', state],
      ['ST-1', state],
    ]);
    expect(opened(a.operatorId)).toBe(lost.id);
  });

  it('a non-transient error from createPaymentToken: link_failed with payment_token_failed; /refresh answers 200', async () => {
    const a = operator();
    await startAndApprove(a.operatorId, a.key);
    h.paypal.createPaymentToken = async () => {
      throw apiError(422, ['INVALID_SETUP_TOKEN'], { path: '/v3/vault/payment-tokens' });
    };
    const res = await h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    expect(res.status).toBe(200);
    expect(res.body['wallet']).toMatchObject({ status: 'link_failed', linkError: 'payment_token_failed' });
    expect(h.wallet(a.operatorId)).toMatchObject({ status: 'link_failed', link_error: 'payment_token_failed', link_state: null, setup_token_id: null });
    const [audit] = audits('wallet.link_failed');
    expect(audit).toMatchObject({ actor_type: 'system', resource_id: a.operatorId });
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ httpStatus: 422, issues: 'INVALID_SETUP_TOKEN' });
    expect(walletEvents().at(-1)).toEqual({ operatorId: a.operatorId, status: 'link_failed' });
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
  });

  it('an error that is not a PayPal answer also ends the link: 200 with link_failed, nothing deleted', async () => {
    const a = operator();
    await startAndApprove(a.operatorId, a.key);
    h.paypal.createPaymentToken = async () => {
      throw new Error('unexpected');
    };
    const res = await h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    expect(res.status).toBe(200);
    expect(res.body['wallet']).toMatchObject({ status: 'link_failed', linkError: 'payment_token_failed' });
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(JSON.parse(audits('wallet.link_failed')[0]?.details ?? '{}')).toEqual({ errorClass: 'Error' });
  });

  it('the same failure through /paypal/return redirects with status=link_failed', async () => {
    const a = operator();
    h.paypal.createPaymentToken = async () => {
      throw apiError(400, ['INVALID_REQUEST'], { path: '/v3/vault/payment-tokens' });
    };
    expect(await link(a.operatorId, a.key)).toBe('link_failed');
    expect(h.wallet(a.operatorId).link_error).toBe('payment_token_failed');
  });

  it('a transient error leaves the wallet unchanged, and /refresh answers 502', async () => {
    const a = operator();
    await startAndApprove(a.operatorId, a.key);
    const before = h.wallet(a.operatorId);
    h.paypal.createPaymentToken = async () => {
      throw networkError();
    };
    const res = await h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    expect(res.status).toBe(502);
    expect(res.body['error']).toBe('paypal_unavailable');
    expect(h.wallet(a.operatorId)).toEqual(before);
    expect(audits('wallet.link_failed')).toEqual([]);
  });

  it('storing throws: link_failed, and the created token is deleted when nobody else holds it', async () => {
    const a = operator();
    await startAndApprove(a.operatorId, a.key);
    vi.spyOn(h.services.ctx.box, 'seal').mockImplementationOnce(() => {
      throw new Error('seal failed');
    });
    const res = await h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    expect(res.status).toBe(200);
    expect(res.body['wallet']).toMatchObject({ status: 'link_failed', linkError: 'payment_token_failed' });
    expect(h.paypal.deletedTokens).toEqual(['PT-2']);
    expect(audits('wallet.link_failed')).toHaveLength(1);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all())).not.toContain('PT-2');
  });

  it('storing throws: the created token is kept when another live holder exists', async () => {
    operator(SHARED);
    const a = operator();
    h.paypal.existingPaymentToken = SHARED;
    await startAndApprove(a.operatorId, a.key);
    vi.spyOn(h.services.ctx.box, 'seal').mockImplementationOnce(() => {
      throw new Error('seal failed');
    });
    const res = await h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    expect(res.body['wallet']).toMatchObject({ status: 'link_failed' });
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(audits('wallet.token_kept_shared').map((r) => r.resource_id)).toEqual([a.operatorId]);
  });

  it('storing throws after a twin stored the same token: nothing is released and the wallet stays active', async () => {
    const a = operator();
    const state = await startAndApprove(a.operatorId, a.key);
    const hold = h.paypal.hold('createPaymentToken');
    const refresh = h.api('POST', '/v1/operator/wallet/refresh', { key: a.key });
    await hold.entered;
    const ret = await h.api('GET', `/paypal/return?state=${state}`);
    expect(ret.headers.get('location')).toBe('https://app.test/link/complete?status=active');
    vi.spyOn(h.services.ctx.box, 'seal').mockImplementationOnce(() => {
      throw new Error('seal failed');
    });
    hold.release();
    const res = await refresh;
    expect(res.status).toBe(200);
    expect(res.body['wallet']).toMatchObject({ status: 'active' });
    expect(h.wallet(a.operatorId).status).toBe('active');
    expect(h.paypal.callsOf('deletePaymentToken')).toEqual([]);
    expect(audits('wallet.link_failed')).toEqual([]);
  });
});
