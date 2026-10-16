import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateSetupTokenInput } from '@payper402/paypal-client';
import {
  ASSET,
  BINDING_VERSION,
  ErrorCode,
  PAYPAL_SANDBOX_NETWORK,
  SCHEME,
  buildCommitment,
  signCommitment,
  type AgentKey,
} from '@payper402/scheme-paypal';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { PayPalApiError } from '@payper402/paypal-client';
import type { LogFields, Logger } from './logger';
import { relinkOutcomeTx } from './services/wallet-state';
import { apiError, captureWith, createHarness, networkError, T0, type Harness } from './test-support';

const DAY = 86_400;

function verifyPayment(h: Harness, key: AgentKey, payTo: string) {
  const req: PaymentRequirements = {
    scheme: SCHEME,
    network: PAYPAL_SANDBOX_NETWORK,
    asset: ASSET,
    amount: '5',
    payTo,
    maxTimeoutSeconds: 300,
    extra: { version: BINDING_VERSION },
  };
  const commitment = buildCommitment({ kid: key.kid, network: req.network, asset: ASSET, payTo, maxAmount: '5', iat: h.clock.now, exp: h.clock.now + 120 });
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: 'https://seller.test/x' },
    accepted: req,
    payload: { commitment, signature: signCommitment(commitment, key.privateKey) },
  };
  return h.services.facilitator.verify(payload, req);
}

function lastSetupInput(h: Harness): CreateSetupTokenInput {
  const calls = h.paypal.callsOf('createSetupToken');
  return calls[calls.length - 1]?.[0] as CreateSetupTokenInput;
}

function stateOf(input: CreateSetupTokenInput): string {
  return new URL(input.returnUrl).searchParams.get('state') ?? '';
}

function webhook(h: Harness, event: Record<string, unknown>) {
  return h.api('POST', '/webhooks/paypal', {
    headers: { 'paypal-transmission-sig': 'valid', 'paypal-transmission-id': 'tx' },
    body: event,
  });
}

describe('wallet linking', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;

  beforeEach(() => {
    h = createHarness({ config: { webAppUrl: 'https://app.test' } });
    ({ operatorId, key } = h.addOperator());
  });
  afterEach(async () => {
    await h.close();
  });

  /** Starts a link and approves its setup token at the fake PayPal. Returns the state. */
  async function linkAndApprove(): Promise<string> {
    const res = await h.api('POST', '/v1/operator/wallet/link', { key });
    expect(res.status).toBe(200);
    const input = lastSetupInput(h);
    const setupTokenId = h.wallet(operatorId).setup_token_id ?? '';
    h.paypal.approve(setupTokenId);
    return stateOf(input);
  }

  it('links end to end: setup token, approval, return, payment token, active', async () => {
    const res = await h.api('POST', '/v1/operator/wallet/link', { key });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approveUrl: 'https://www.sandbox.paypal.com/approve?token=ST-1', expiresAt: T0 + 3 * DAY });
    const input = lastSetupInput(h);
    const state = stateOf(input);
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(input).toMatchObject({
      returnUrl: `http://localhost:4020/paypal/return?state=${state}`,
      cancelUrl: `http://localhost:4020/paypal/cancel?state=${state}`,
      brandName: 'PayPer402',
      description: 'PayPer402: your AI agents pay per API call; charges are batched to this PayPal account.',
    });
    expect(h.wallet(operatorId)).toMatchObject({ status: 'waiting_for_approval', link_state: state, setup_token_id: 'ST-1', link_started_at: T0 });

    h.paypal.approve('ST-1');
    const back = await h.api('GET', `/paypal/return?state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('https://app.test/link/complete?status=active');
    expect(h.paypal.callsOf('createPaymentToken')).toEqual([['ST-1', state]]);
    const wallet = h.wallet(operatorId);
    expect(wallet).toMatchObject({
      status: 'active',
      link_state: null,
      setup_token_id: null,
      payer_email_masked: 'bu***@example.com',
      paypal_customer_id: 'CUST-1',
      linked_at: T0,
    });
    // Sealed at rest: the raw payment token id never appears in the row.
    expect(JSON.stringify(wallet)).not.toContain('PT-2');
    expect(h.services.ctx.box.open(wallet.vault_id_sealed ?? '')).toBe('PT-2');
    expect(wallet.vault_id_hash).toBe(h.services.ctx.box.lookupHash('PT-2'));
    expect(h.seen.filter((e) => e.type === 'wallet.updated').map((e) => e.data)).toEqual([
      { status: 'waiting_for_approval' },
      { status: 'active' },
    ]);

    // The state is single use.
    const again = await h.api('GET', `/paypal/return?state=${state}`);
    expect(again.headers.get('location')).toBe('https://app.test/link/complete?status=unknown');
    expect(h.paypal.callsOf('createPaymentToken')).toHaveLength(1);

    const overview = await h.api('GET', '/v1/operator', { key });
    expect(overview.body['wallet']).toMatchObject({ status: 'active', payerEmailMasked: 'bu***@example.com', linkedAt: T0 });
  });

  it('leaves the wallet unchanged until approved, then finishes on refresh', async () => {
    await h.api('POST', '/v1/operator/wallet/link', { key });
    const early = await h.api('POST', '/v1/operator/wallet/refresh', { key });
    expect(early.status).toBe(200);
    expect(early.body['wallet']).toMatchObject({ status: 'waiting_for_approval' });
    expect(h.paypal.callsOf('createPaymentToken')).toHaveLength(0);
    h.paypal.approve('ST-1');
    const late = await h.api('POST', '/v1/operator/wallet/refresh', { key });
    expect(late.body['wallet']).toMatchObject({ status: 'active' });
  });

  it('marks a cancelled link link_failed', async () => {
    await h.api('POST', '/v1/operator/wallet/link', { key });
    const state = stateOf(lastSetupInput(h));
    const res = await h.api('GET', `/paypal/cancel?state=${state}`);
    expect(res.headers.get('location')).toBe('https://app.test/link/complete?status=link_failed');
    expect(h.wallet(operatorId)).toMatchObject({ status: 'link_failed', link_error: 'cancelled', link_state: null });
  });

  it('answers an unknown state with the redirect and changes nothing', async () => {
    await h.api('POST', '/v1/operator/wallet/link', { key });
    const before = h.wallet(operatorId);
    for (const path of ['/paypal/return?state=nope', '/paypal/cancel?state=nope', '/paypal/return']) {
      const res = await h.api('GET', path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://app.test/link/complete?status=unknown');
    }
    expect(h.wallet(operatorId)).toEqual(before);
    expect(h.paypal.callsOf('getSetupToken')).toHaveLength(0);
  });

  it('shows a minimal page when WEB_APP_URL is unset', async () => {
    const plain = createHarness();
    try {
      const res = await plain.api('GET', '/paypal/return?state=nope');
      expect(res.status).toBe(200);
      expect(String(res.body['text'])).toContain('Linking did not complete');
    } finally {
      await plain.close();
    }
  });

  it('expires a link that was never approved after 3 days', async () => {
    await h.api('POST', '/v1/operator/wallet/link', { key });
    h.clock.now += 3 * DAY;
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId).status).toBe('waiting_for_approval');
    h.clock.now += 1;
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId)).toMatchObject({ status: 'link_failed', link_error: 'expired', setup_token_id: null });
  });

  it('never expires once a payment token exists', async () => {
    const agent = h.addAgent(operatorId);
    h.addCommitment({ operatorId, agentId: agent.agentId, payTo: 'sel_x', amount: 9, state: 'uncollectable' });
    h.paypal.chargeScripts.push(() => {
      throw apiError(400, ['SOMETHING_ODD']);
    });
    const state = await linkAndApprove();
    await h.api('GET', `/paypal/return?state=${state}`);
    expect(h.settlements(operatorId)[0]).toMatchObject({ trigger: 'relink', status: 'needs_review' });
    expect(h.wallet(operatorId).status).toBe('waiting_for_approval');
    h.clock.now += 10 * DAY;
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId).status).toBe('waiting_for_approval');
    expect(h.paypal.deletedTokens).toEqual([]);
  });

  it('refuses to link while active or unlinking', async () => {
    h.activateWallet(operatorId);
    const res = await h.api('POST', '/v1/operator/wallet/link', { key });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('wallet_already_active');
    h.db.prepare(`UPDATE wallets SET status = 'unlinking'`).run();
    expect((await h.api('POST', '/v1/operator/wallet/link', { key })).body['error']).toBe('wallet_already_active');
  });

  it('refuses a link restart while a finished link waits for its relink behind another pending settlement', async () => {
    const agentId = h.addAgent(operatorId).agentId;
    h.activateWallet(operatorId, 'PT-NEW');
    h.db.prepare(`UPDATE wallets SET status = 'waiting_for_approval'`).run();
    const c = h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 4, state: 'settling' });
    h.db
      .prepare(
        `INSERT INTO settlements (id, operator_id, trigger, status, amount, calls_count, paypal_request_id, created_at, updated_at)
         VALUES ('stl_p', ?, 'threshold', 'pending', 4, 1, 'stl_p', ?, ?)`,
      )
      .run(operatorId, T0, T0);
    h.db.prepare(`INSERT INTO settlement_items VALUES ('stl_p', ?, 'sel_a', 4)`).run(c);
    h.db.prepare(`UPDATE commitments SET settlement_id = 'stl_p'`).run();
    const res = await h.api('POST', '/v1/operator/wallet/link', { key });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('settlement_in_progress');
    expect(h.paypal.deletedTokens).toEqual([]);
    expect(h.paypal.callsOf('createSetupToken')).toEqual([]);
  });

  it('deletes an earlier payment token when linking again after revocation', async () => {
    h.activateWallet(operatorId, 'PT-OLD');
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer'`).run();
    expect((await h.api('POST', '/v1/operator/wallet/link', { key })).status).toBe(200);
    expect(h.paypal.deletedTokens).toEqual(['PT-OLD']);
    expect(h.wallet(operatorId)).toMatchObject({ vault_id_sealed: null, vault_id_hash: null, status: 'waiting_for_approval' });
  });

  it('maps PayPal failures while linking to 502', async () => {
    h.paypal.createSetupToken = async () => {
      throw networkError();
    };
    const res = await h.api('POST', '/v1/operator/wallet/link', { key });
    expect(res.status).toBe(502);
    expect(res.body['error']).toBe('paypal_unavailable');
    expect(h.wallet(operatorId).status).toBe('not_linked');
  });

  describe('relink with uncollectable commitments', () => {
    let agentId: string;
    let debt: string[];

    beforeEach(() => {
      agentId = h.addAgent(operatorId).agentId;
      h.activateWallet(operatorId, 'PT-OLD');
      h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer'`).run();
      debt = [
        h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 7, state: 'uncollectable' }),
        h.addCommitment({ operatorId, agentId, payTo: 'sel_b', amount: 5, state: 'uncollectable' }),
      ];
    });

    it('completed: the wallet becomes active and the debt is settled', async () => {
      const state = await linkAndApprove();
      const res = await h.api('GET', `/paypal/return?state=${state}`);
      expect(res.headers.get('location')).toBe('https://app.test/link/complete?status=active');
      expect(h.settlements(operatorId)).toEqual([expect.objectContaining({ trigger: 'relink', status: 'completed', amount: 12, calls_count: 2 })]);
      expect(h.commitmentStates(operatorId)).toEqual({ settled: 2 });
      expect(h.wallet(operatorId).status).toBe('active');
      h.checkInvariants();
    });

    it.each([
      ['a declined capture', () => captureWith('DECLINED', 12)],
      ['a decline error', () => {
        throw apiError(422, ['INSTRUMENT_DECLINED']);
      }],
      ['a revocation error', () => {
        throw apiError(422, ['AGREEMENT_ALREADY_CANCELLED']);
      }],
    ])('%s: link_failed, the new token deleted, the debt back to uncollectable', async (_label, script) => {
      h.paypal.chargeScripts.push(script);
      const state = await linkAndApprove();
      await h.api('GET', `/paypal/return?state=${state}`);
      const [settlement] = h.settlements(operatorId);
      expect(settlement).toMatchObject({ trigger: 'relink', status: 'failed' });
      expect(h.wallet(operatorId)).toMatchObject({
        status: 'link_failed',
        link_error: 'relink_settlement_failed',
        vault_id_sealed: null,
        vault_id_hash: null,
      });
      expect(h.paypal.deletedTokens).toContain('PT-2');
      const rows = h.db.prepare('SELECT state, settlement_id FROM commitments WHERE id IN (?, ?)').all(...debt);
      expect(rows).toEqual([
        { state: 'uncollectable', settlement_id: settlement?.id },
        { state: 'uncollectable', settlement_id: settlement?.id },
      ]);
      h.checkInvariants();
    });

    it('needs_review: the wallet stays waiting_for_approval and nothing is deleted', async () => {
      h.paypal.chargeScripts.push(() => {
        throw apiError(400, ['UNKNOWN_THING']);
      });
      const state = await linkAndApprove();
      await h.api('GET', `/paypal/return?state=${state}`);
      expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'needs_review', failure_code: 'paypal_error' });
      expect(h.wallet(operatorId).status).toBe('waiting_for_approval');
      expect(h.paypal.deletedTokens).toEqual(['PT-OLD']);
      expect(h.commitmentStates(operatorId)).toEqual({ settling: 2 });
    });

    it('a PENDING capture resolved later by webhook makes the wallet active', async () => {
      h.paypal.chargeScripts.push(() => captureWith('PENDING', 12, 'ORDER-R', 'CAP-R'));
      const state = await linkAndApprove();
      await h.api('GET', `/paypal/return?state=${state}`);
      expect(h.wallet(operatorId).status).toBe('waiting_for_approval');
      expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'pending', capture_status: 'PENDING', paypal_order_id: 'ORDER-R' });
      const res = await webhook(h, {
        id: 'WH-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAP-R', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.12' } },
      });
      expect(res.status).toBe(200);
      expect(h.wallet(operatorId).status).toBe('active');
      expect(h.commitmentStates(operatorId)).toEqual({ settled: 2 });
    });

    it('refuses link and refresh while the relink settlement is pending', async () => {
      h.paypal.chargeScripts.push(() => {
        throw networkError();
      });
      const state = await linkAndApprove();
      await h.api('GET', `/paypal/return?state=${state}`);
      expect(h.settlements(operatorId)[0]).toMatchObject({ trigger: 'relink', status: 'pending', attempts: 1 });
      expect((await h.api('POST', '/v1/operator/wallet/link', { key })).body['error']).toBe('settlement_in_progress');
      expect((await h.api('POST', '/v1/operator/wallet/refresh', { key })).body['error']).toBe('settlement_in_progress');
      // The retry completes the relink.
      h.clock.now += 30;
      await h.services.jobs.runTick();
      expect(h.wallet(operatorId).status).toBe('active');
    });
  });

  describe('compare-and-set races', () => {
    it('a concurrent return and refresh with debt produce exactly one relink settlement', async () => {
      const agentId = h.addAgent(operatorId).agentId;
      h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 9, state: 'uncollectable' });
      const state = await linkAndApprove();
      const charge = h.paypal.hold('chargeVaultedWallet');
      const ret = h.api('GET', `/paypal/return?state=${state}`);
      const refresh = h.api('POST', '/v1/operator/wallet/refresh', { key });
      await charge.entered;
      const first = await Promise.race([ret.then(() => 'return'), refresh.then(() => 'refresh')]);
      expect(['return', 'refresh']).toContain(first);
      expect(h.settlements(operatorId)).toHaveLength(1);
      expect(h.wallet(operatorId).status).toBe('waiting_for_approval');
      charge.release();
      await Promise.all([ret, refresh]);
      expect(h.settlements(operatorId)).toEqual([expect.objectContaining({ trigger: 'relink', status: 'completed' })]);
      expect(h.wallet(operatorId).status).toBe('active');
      expect(h.paypal.deletedTokens).toEqual([]);
      expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(1);
    });

    it('a concurrent return and refresh without debt both answer normally; one write wins', async () => {
      const state = await linkAndApprove();
      const [ret, refresh] = await Promise.all([
        h.api('GET', `/paypal/return?state=${state}`),
        h.api('POST', '/v1/operator/wallet/refresh', { key }),
      ]);
      expect(ret.status).toBe(302);
      expect(refresh.status).toBe(200);
      expect(h.wallet(operatorId).status).toBe('active');
      expect(h.paypal.deletedTokens).toEqual([]);
      expect(new Set(h.paypal.callsOf('createPaymentToken').map((args) => args[1]))).toEqual(new Set([state]));
    });

    it('a link restart during an in-flight finish keeps the new link and deletes the orphaned token', async () => {
      await linkAndApprove();
      const hold = h.paypal.hold('createPaymentToken');
      const refresh = h.api('POST', '/v1/operator/wallet/refresh', { key });
      await hold.entered;
      expect((await h.api('POST', '/v1/operator/wallet/link', { key })).status).toBe(200);
      const restarted = h.wallet(operatorId);
      expect(restarted.setup_token_id).toBe('ST-2');
      hold.release();
      const res = await refresh;
      expect(res.status).toBe(200);
      expect(res.body['wallet']).toMatchObject({ status: 'waiting_for_approval' });
      expect(h.wallet(operatorId)).toMatchObject({
        status: 'waiting_for_approval',
        link_state: restarted.link_state,
        setup_token_id: 'ST-2',
        vault_id_hash: null,
      });
      expect(h.paypal.deletedTokens).toEqual(['PT-3']);
    });

    it('a relink outcome applied after a link restart leaves the new wallet alone and deletes nothing', async () => {
      const agentId = h.addAgent(operatorId).agentId;
      const box = h.services.ctx.box;
      const oldHash = box.lookupHash('PT-OLD');
      const commitment = h.addCommitment({ operatorId, agentId, payTo: 'sel_a', amount: 4, state: 'settling' });
      h.db.prepare(
        `INSERT INTO settlements (id, operator_id, trigger, status, amount, calls_count, paypal_request_id, vault_id_hash,
           paypal_order_id, paypal_capture_id, capture_status, created_at, updated_at)
         VALUES ('stl_r', ?, 'relink', 'pending', 4, 1, 'stl_r', ?, 'O-R', 'C-R', 'PENDING', ?, ?)`,
      ).run(operatorId, oldHash, T0, T0);
      h.db.prepare(`INSERT INTO settlement_items VALUES ('stl_r', ?, 'sel_a', 4)`).run(commitment);
      h.db.prepare(`UPDATE commitments SET settlement_id = 'stl_r' WHERE id = ?`).run(commitment);
      // The wallet was restarted: a new state and setup token, no vault.
      h.db.prepare(`UPDATE wallets SET status = 'waiting_for_approval', link_state = 'new', setup_token_id = 'ST-9' WHERE operator_id = ?`).run(operatorId);
      const before = h.wallet(operatorId);

      expect(relinkOutcomeTx(h.db, operatorId, oldHash, 'completed', T0)).toEqual({ changed: false });
      expect(relinkOutcomeTx(h.db, operatorId, oldHash, 'failed', T0)).toEqual({ changed: false });
      const outcome = await h.services.settlements.applyCaptureWebhook('PAYMENT.CAPTURE.DECLINED', { id: 'C-R', status: 'DECLINED' });
      expect(outcome).toBe('declined');
      expect(h.wallet(operatorId)).toEqual(before);
      expect(h.paypal.deletedTokens).toEqual([]);
      expect(h.db.prepare('SELECT state, settlement_id FROM commitments WHERE id = ?').get(commitment)).toEqual({
        state: 'uncollectable',
        settlement_id: 'stl_r',
      });
    });
  });
});

describe('unlinking', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;
  let agentId: string;
  let agentKey: AgentKey;
  let sellerId: string;

  beforeEach(() => {
    h = createHarness();
    ({ operatorId, key } = h.addOperator());
    ({ agentId, key: agentKey } = h.addAgent(operatorId));
    sellerId = h.addSeller().sellerId;
    h.activateWallet(operatorId, 'PT-U');
  });
  afterEach(async () => {
    await h.close();
  });

  it('unlinks at once with no unsettled commitments', async () => {
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(200);
    expect(res.body['wallet']).toMatchObject({ status: 'not_linked', payerEmailMasked: null });
    expect(h.paypal.deletedTokens).toEqual(['PT-U']);
    expect(h.wallet(operatorId)).toMatchObject({ status: 'not_linked', vault_id_sealed: null, vault_id_hash: null });
    expect(h.settlements(operatorId)).toEqual([]);
    expect(h.seen.filter((e) => e.type === 'wallet.updated').map((e) => e.data)).toEqual([{ status: 'unlinking' }, { status: 'not_linked' }]);
  });

  it('charges the unsettled commitments first, then unlinks', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 8 });
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(200);
    expect(h.settlements(operatorId)).toEqual([expect.objectContaining({ trigger: 'unlink', status: 'completed', amount: 8 })]);
    expect(h.wallet(operatorId).status).toBe('not_linked');
    expect(h.paypal.deletedTokens).toEqual(['PT-U']);
  });

  it('answers 409 settlement_failed and stays active when the unlink charge is declined', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 8 });
    h.paypal.chargeScripts.push(() => {
      throw apiError(422, ['INSTRUMENT_DECLINED']);
    });
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'settlement_failed', wallet: { status: 'active' } });
    expect(h.wallet(operatorId).status).toBe('active');
    expect(h.paypal.deletedTokens).toEqual([]);
    expect(h.commitmentStates(operatorId)).toEqual({ unsettled: 1 });
  });

  it('answers 409 settlement_in_progress while pending; the unlink finishes when the charge completes', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 8 });
    h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('settlement_in_progress');
    expect(h.wallet(operatorId).status).toBe('unlinking');

    // While unlinking, a new commitment is refused.
    expect(await verifyPayment(h, agentKey, sellerId)).toMatchObject({ isValid: false, invalidReason: ErrorCode.walletNotLinked });

    h.clock.now += 30;
    await h.services.jobs.runTick();
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect(h.wallet(operatorId).status).toBe('not_linked');
    expect(h.paypal.deletedTokens).toEqual(['PT-U']);
  });

  it('refuses to unlink a wallet that is not active', async () => {
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer'`).run();
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('wallet_not_active');
  });

  it('race: a webhook revocation during a pending unlink, then a decline, leaves stopped_by_payer', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 8 });
    h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(h.wallet(operatorId).status).toBe('unlinking');
    await webhook(h, { id: 'WH-R', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'PT-U' } });
    expect(h.wallet(operatorId).status).toBe('stopped_by_payer');
    h.paypal.chargeScripts.push(() => captureWith('DECLINED', 8));
    h.clock.now += 30;
    await h.services.jobs.runTick();
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'failed', failure_code: 'declined' });
    expect(h.wallet(operatorId).status).toBe('stopped_by_payer');
  });

  it('race: unlink while a threshold settlement is pending answers 409 and stays active', async () => {
    // Default caps: perCall 25, unsettled 100, so the threshold is 75 cents.
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 80 });
    h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    await h.services.settlements.triggerThreshold(operatorId);
    expect(h.settlements(operatorId)[0]).toMatchObject({ trigger: 'threshold', status: 'pending' });
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('settlement_in_progress');
    expect(h.wallet(operatorId).status).toBe('active');
  });
});

describe('revocation detection', () => {
  let h: Harness;
  let operatorId: string;
  let agentKey: AgentKey;
  let sellerId: string;

  beforeEach(() => {
    h = createHarness();
    operatorId = h.addOperator().operatorId;
    agentKey = h.addAgent(operatorId).key;
    sellerId = h.addSeller().sellerId;
    h.activateWallet(operatorId, 'PT-H');
  });
  afterEach(async () => {
    await h.close();
  });

  it('revokes on a 404 from the health check; verify then fails with wallet_revoked', async () => {
    const agentId = h.db.prepare('SELECT id FROM agents').get() as { id: string };
    h.addCommitment({ operatorId, agentId: agentId.id, payTo: sellerId, amount: 3 });
    expect(await verifyPayment(h, agentKey, sellerId)).toMatchObject({ isValid: true });
    h.paypal.paymentTokens.delete('PT-H');
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId)).toMatchObject({ status: 'stopped_by_payer', stopped_at: T0, last_checked_at: T0 });
    expect(h.commitmentStates(operatorId)).toEqual({ uncollectable: 1 });
    expect(await verifyPayment(h, agentKey, sellerId)).toMatchObject({ isValid: false, invalidReason: ErrorCode.walletRevoked });
    expect(h.seen.filter((e) => e.type === 'wallet.updated').at(-1)?.data).toEqual({ status: 'stopped_by_payer' });
  });

  it('revokes on the VAULT.PAYMENT-TOKEN.DELETED webhook', async () => {
    const res = await webhook(h, { id: 'WH-D', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'PT-H' } });
    expect(res.status).toBe(200);
    expect(h.wallet(operatorId).status).toBe('stopped_by_payer');
    expect(await verifyPayment(h, agentKey, sellerId)).toMatchObject({ isValid: false, invalidReason: ErrorCode.walletRevoked });
    expect(h.db.prepare('SELECT outcome FROM webhook_events').get()).toEqual({ outcome: 'wallet_revoked' });
  });

  it.each([
    ['a transient error', () => networkError()],
    ['a 403', () => apiError(403, ['PERMISSION_DENIED'])],
  ])('ignores %s from the health check', async (_label, makeError) => {
    h.paypal.getPaymentTokenError = makeError();
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId)).toMatchObject({ status: 'active', last_checked_at: T0 });
  });

  it('checks each wallet at most once per interval and at most 10 per tick, never-checked and oldest first', async () => {
    for (let i = 0; i < 11; i += 1) {
      const op = h.addOperator().operatorId;
      h.activateWallet(op, `PT-${i}`);
    }
    h.db.prepare(`UPDATE wallets SET last_checked_at = ? WHERE operator_id = ?`).run(T0 - 1000, operatorId);
    await h.services.jobs.runTick();
    expect(h.paypal.callsOf('getPaymentToken')).toHaveLength(10);
    expect(h.wallet(operatorId).last_checked_at).toBe(T0 - 1000);
    await h.services.jobs.runTick();
    expect(h.paypal.callsOf('getPaymentToken')).toHaveLength(12);
    expect(h.wallet(operatorId).last_checked_at).toBe(T0);
    await h.services.jobs.runTick();
    expect(h.paypal.callsOf('getPaymentToken')).toHaveLength(12);
    h.clock.now += 30;
    await h.services.jobs.runTick();
    expect(h.paypal.callsOf('getPaymentToken')).toHaveLength(22);
  });
});

describe('vault ids stay out of logs and the audit log', () => {
  const lines: string[] = [];
  const capture = (level: string) => (message: string, fields?: LogFields) => {
    lines.push(JSON.stringify({ level, message, ...fields }));
  };
  const logger: Logger = { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') };
  // Worst case: an error whose path and message both carry the id.
  const leakyError = (id: string) =>
    new PayPalApiError({
      httpStatus: 500,
      name: 'INTERNAL_SERVER_ERROR',
      message: `failed for ${id}`,
      issues: [],
      method: 'GET',
      path: `/v3/vault/payment-tokens/${id}`,
      debugId: 'dbg-1',
    });
  let h: Harness;

  beforeEach(() => {
    lines.length = 0;
    h = createHarness({ logger });
  });
  afterEach(async () => {
    await h.close();
  });

  const everything = () => lines.join('\n') + JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all());

  it('on a failed health check', async () => {
    const { operatorId } = h.addOperator();
    h.activateWallet(operatorId, 'PT-HEALTH');
    h.paypal.getPaymentTokenError = leakyError('PT-HEALTH');
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId).status).toBe('active');
    expect(lines.some((l) => l.includes('Wallet health check failed') && l.includes('dbg-1'))).toBe(true);
    expect(everything()).not.toContain('PT-HEALTH');
  });

  it('on a failed token deletion during unlink', async () => {
    const { operatorId, key } = h.addOperator();
    h.activateWallet(operatorId, 'PT-DELETE');
    h.paypal.deletePaymentToken = async () => {
      throw leakyError('PT-DELETE');
    };
    const res = await h.api('POST', '/v1/operator/wallet/unlink', { key });
    expect(res.status).toBe(200);
    expect(h.wallet(operatorId).status).toBe('not_linked');
    expect(h.db.prepare(`SELECT action FROM audit_log WHERE action = 'wallet.token_delete_failed'`).get()).toBeTruthy();
    expect(everything()).not.toContain('PT-DELETE');
    expect(JSON.stringify(res.body)).not.toContain('PT-DELETE');
  });
});
