import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChargeVaultedWalletInput } from '@payper402/paypal-client';
import { utcDayStart } from '@payper402/scheme-paypal';
import type { SettlementRow } from './db/rows';
import { apiError, captureWith, completedCharge, createHarness, networkError, T0, type Harness } from './test-support';

describe('settlements', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;
  let agentId: string;
  let sellerId: string;

  const add = (amount: number, extra: { recordedAt?: number; payTo?: string } = {}) =>
    h.addCommitment({ operatorId, agentId, payTo: extra.payTo ?? sellerId, amount, ...(extra.recordedAt === undefined ? {} : { recordedAt: extra.recordedAt }) });
  const only = (): SettlementRow => {
    const rows = h.settlements(operatorId);
    expect(rows).toHaveLength(1);
    return rows[0] as SettlementRow;
  };

  beforeEach(() => {
    h = createHarness();
    // Threshold = max(1, unsettled - perCall) = 40 cents.
    ({ operatorId, key } = h.addOperator({ caps: { perCall: 10, daily: 1000, unsettled: 50 } }));
    agentId = h.addAgent(operatorId).agentId;
    sellerId = h.addSeller().sellerId;
    h.activateWallet(operatorId, 'PT-S');
  });
  afterEach(async () => {
    h.checkInvariants();
    await h.close();
  });

  describe('triggers', () => {
    it('fires the threshold at cap_unsettled - cap_per_call and not before', async () => {
      add(20);
      add(19);
      expect(await h.services.settlements.triggerThreshold(operatorId)).toBeUndefined();
      await h.services.jobs.runTick();
      expect(h.settlements(operatorId)).toEqual([]);
      add(1);
      const settlement = await h.services.settlements.triggerThreshold(operatorId);
      expect(settlement).toMatchObject({ trigger: 'threshold', status: 'completed', amount: 40, calls_count: 3 });
      expect(h.paypal.callsOf('chargeVaultedWallet')[0]?.[0]).toEqual({
        vaultId: 'PT-S',
        amountCents: 40,
        requestId: settlement?.id,
        invoiceId: settlement?.id,
        description: 'PayPer402 usage: 3 paid calls',
      });
    });

    it('uses a threshold of at least 1 cent', async () => {
      h.db.prepare('UPDATE operators SET cap_per_call = 50').run();
      add(1);
      expect(await h.services.settlements.triggerThreshold(operatorId)).toMatchObject({ amount: 1 });
    });

    it('fires the threshold from the ledger hook', async () => {
      add(35);
      h.services.ledger
        .record(
          { id: 'cmt_hook', kid: 'kid', agentId, operatorId, payTo: sellerId, resourceUrl: 'https://s.test/x', maxAmount: 10, amount: 10, iat: T0, recordedAt: T0, payloadHash: 'h' },
          { perCall: 10, daily: 1000, unsettled: 50 },
          T0,
        )
        .catch(() => undefined);
      await h.services.settlements.background.idle();
      expect(only()).toMatchObject({ trigger: 'threshold', status: 'completed', amount: 45 });
    });

    it('fires the daily trigger after a UTC midnight', async () => {
      add(5);
      await h.services.jobs.runTick();
      expect(h.settlements(operatorId)).toEqual([]);
      h.clock.now = utcDayStart(T0) + 86_400 - 1;
      await h.services.jobs.runTick();
      expect(h.settlements(operatorId)).toEqual([]);
      h.clock.now += 1;
      add(3, { recordedAt: h.clock.now });
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ trigger: 'daily', status: 'completed', amount: 8, calls_count: 2 });
    });

    it('settles manually with 201, or answers 409', async () => {
      const nothing = await h.api('POST', '/v1/settlements', { key });
      expect(nothing.status).toBe(409);
      expect(nothing.body['error']).toBe('nothing_to_settle');

      add(7);
      const created = await h.api('POST', '/v1/settlements', { key });
      expect(created.status).toBe(201);
      expect(created.body['settlement']).toMatchObject({ trigger: 'manual', status: 'completed', amount: 7, callsCount: 1, fee: 30, net: -23 });

      add(4);
      h.paypal.chargeScripts.push(() => {
        throw networkError();
      });
      expect((await h.api('POST', '/v1/settlements', { key })).status).toBe(201);
      const busy = await h.api('POST', '/v1/settlements', { key });
      expect(busy.status).toBe(409);
      expect(busy.body['error']).toBe('settlement_in_progress');

      h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer'`).run();
      const inactive = await h.api('POST', '/v1/settlements', { key });
      expect(inactive.body['error']).toBe('wallet_not_active');
      h.db.prepare(`UPDATE settlements SET status = 'failed' WHERE status = 'pending'`).run();
      h.db.prepare(`UPDATE commitments SET state = 'unsettled', settlement_id = NULL WHERE state = 'settling'`).run();
    });

    it('skips automatic triggers while charge_retry_after is in the future', async () => {
      add(45);
      h.db.prepare('UPDATE wallets SET charge_retry_after = ?').run(T0 + 900);
      await h.services.jobs.runTick();
      expect(h.settlements(operatorId)).toEqual([]);
      h.clock.now = T0 + 900;
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ trigger: 'threshold', status: 'completed' });
    });

    it('produces only one settlement from concurrent triggers', async () => {
      add(45);
      const hold = h.paypal.hold('chargeVaultedWallet');
      const runs = Promise.all([
        h.services.settlements.triggerThreshold(operatorId),
        h.services.settlements.triggerThreshold(operatorId),
        h.services.settlements.settleManually(operatorId).catch((err: unknown) => err),
        h.services.jobs.runTick(),
        h.services.jobs.runTick(),
      ]);
      await hold.entered;
      hold.release();
      const [, , manual] = await runs;
      expect(manual).toMatchObject({ code: 'settlement_in_progress' });
      expect(only()).toMatchObject({ status: 'completed', amount: 45 });
      expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(1);
    });
  });

  describe('outcomes', () => {
    it('COMPLETED: completed with fee and net, commitments settled, retry pause cleared', async () => {
      add(45);
      h.db.prepare('UPDATE wallets SET charge_retry_after = ?').run(T0 - 1);
      h.paypal.chargeScripts.push((input) => completedCharge(input.amountCents, 'O-1', 'C-1'));
      await h.services.settlements.triggerThreshold(operatorId);
      expect(only()).toMatchObject({
        status: 'completed',
        paypal_order_id: 'O-1',
        paypal_capture_id: 'C-1',
        capture_status: 'COMPLETED',
        fee: 30,
        net: 15,
        completed_at: T0,
      });
      expect(h.commitmentStates(operatorId)).toEqual({ settled: 1 });
      expect(h.wallet(operatorId).charge_retry_after).toBeNull();
    });

    it('PENDING resolved later by the capture poll', async () => {
      add(45);
      h.paypal.chargeScripts.push(() => captureWith('PENDING', 45, 'O-P', 'C-P'));
      await h.services.settlements.triggerThreshold(operatorId);
      expect(only()).toMatchObject({ status: 'pending', capture_status: 'PENDING', paypal_order_id: 'O-P', paypal_capture_id: 'C-P' });
      expect(h.commitmentStates(operatorId)).toEqual({ settling: 1 });
      h.paypal.orderScripts.push(() => captureWith('PENDING', 45, 'O-P', 'C-P'));
      await h.services.jobs.runTick();
      expect(only().status).toBe('pending');
      h.paypal.orderScripts.push(() => completedCharge(45, 'O-P', 'C-P'));
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ status: 'completed', fee: 30 });
      expect(h.paypal.callsOf('getOrder')).toEqual([['O-P'], ['O-P']]);
      expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(1);
    });

    it.each([
      ['a DECLINED capture', () => captureWith('DECLINED', 45)],
      ['a FAILED capture', () => captureWith('FAILED', 45)],
      ['a decline error', () => {
        throw apiError(422, ['PAYER_CANNOT_PAY']);
      }],
    ])('%s: failed/declined, commitments back to unsettled, triggers paused 15 minutes', async (_label, script) => {
      const id = add(45);
      h.paypal.chargeScripts.push(script);
      await h.services.settlements.triggerThreshold(operatorId);
      const settlement = only();
      expect(settlement).toMatchObject({ status: 'failed', failure_code: 'declined' });
      expect(h.db.prepare('SELECT state, settlement_id FROM commitments WHERE id = ?').get(id)).toEqual({ state: 'unsettled', settlement_id: null });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM settlement_items WHERE settlement_id = ?').get(settlement.id)).toEqual({ n: 1 });
      expect(h.wallet(operatorId)).toMatchObject({ status: 'active', charge_retry_after: T0 + 900 });
      // A failed settlement still lists what it covered.
      const detail = await h.api('GET', `/v1/settlements/${settlement.id}`, { key });
      expect(detail.body['settlement']).toMatchObject({ status: 'failed', commitments: [expect.objectContaining({ id, amount: 45 })] });
      // Paused, then retried.
      await h.services.jobs.runTick();
      expect(h.settlements(operatorId)).toHaveLength(1);
      h.clock.now = T0 + 900;
      await h.services.jobs.runTick();
      expect(h.settlements(operatorId).map((s) => s.status)).toEqual(['failed', 'completed']);
    });

    it('a decline after the wallet was revoked leaves the batch uncollectable; a later relink collects it', async () => {
      const id = add(45);
      h.paypal.chargeScripts.push(() => captureWith('PENDING', 45, 'O-Q', 'C-Q'));
      await h.services.settlements.triggerThreshold(operatorId);
      const settlement = only();
      const hook = (event: Record<string, unknown>) =>
        h.api('POST', '/webhooks/paypal', { headers: { 'paypal-transmission-sig': 'valid' }, body: event });
      await hook({ id: 'WH-Q1', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'PT-S' } });
      expect(h.wallet(operatorId).status).toBe('stopped_by_payer');
      await hook({ id: 'WH-Q2', event_type: 'PAYMENT.CAPTURE.DECLINED', resource: { id: 'C-Q', status: 'DECLINED' } });
      expect(only()).toMatchObject({ status: 'failed', failure_code: 'declined' });
      expect(h.db.prepare('SELECT state, settlement_id FROM commitments WHERE id = ?').get(id)).toEqual({
        state: 'uncollectable',
        settlement_id: settlement.id,
      });

      // Linking again collects the debt before the wallet becomes active.
      await h.api('POST', '/v1/operator/wallet/link', { key });
      h.paypal.approve(h.wallet(operatorId).setup_token_id ?? '');
      const refreshed = await h.api('POST', '/v1/operator/wallet/refresh', { key });
      expect(refreshed.body['wallet']).toMatchObject({ status: 'active' });
      const rows = h.settlements(operatorId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ trigger: 'relink', status: 'completed', amount: 45, calls_count: 1 });
      expect(h.db.prepare('SELECT state, settlement_id FROM commitments WHERE id = ?').get(id)).toEqual({
        state: 'settled',
        settlement_id: rows[1]?.id,
      });
    });

    it('a revocation error: payer_stopped, the batch and other unsettled commitments uncollectable, wallet revoked', async () => {
      const inBatch = add(45);
      h.paypal.chargeScripts.push(() => {
        throw apiError(422, ['AGREEMENT_ALREADY_CANCELLED']);
      });
      const hold = h.paypal.hold('chargeVaultedWallet');
      const run = h.services.settlements.triggerThreshold(operatorId);
      await hold.entered;
      const outside = add(3);
      hold.release();
      await run;
      const settlement = only();
      expect(settlement).toMatchObject({ status: 'failed', failure_code: 'payer_stopped' });
      expect(h.db.prepare('SELECT id, state, settlement_id FROM commitments ORDER BY id = ? DESC').all(inBatch)).toEqual([
        { id: inBatch, state: 'uncollectable', settlement_id: settlement.id },
        { id: outside, state: 'uncollectable', settlement_id: null },
      ]);
      expect(h.wallet(operatorId)).toMatchObject({ status: 'stopped_by_payer', stopped_at: T0 });
      expect(h.seen.filter((e) => e.type === 'wallet.updated').at(-1)?.data).toEqual({ status: 'stopped_by_payer' });
    });

    it('transient: retried with the same request id and backoff, then needs_review after 2 hours', async () => {
      add(45);
      for (let i = 0; i < 20; i += 1) {
        h.paypal.chargeScripts.push(() => {
          throw i % 2 === 0 ? networkError() : apiError(503);
        });
      }
      await h.services.settlements.triggerThreshold(operatorId);
      const id = only().id;
      expect(only()).toMatchObject({ status: 'pending', attempts: 1, next_attempt_at: T0 + 30 });
      h.clock.now = T0 + 29;
      await h.services.jobs.runTick();
      expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(1);
      h.clock.now = T0 + 30;
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ attempts: 2, next_attempt_at: T0 + 150 });
      h.clock.now = T0 + 150;
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ attempts: 3, next_attempt_at: T0 + 750 });
      h.clock.now = T0 + 750;
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ attempts: 4, next_attempt_at: T0 + 1350 });
      const calls = h.paypal.callsOf('chargeVaultedWallet').map((args) => (args[0] as ChargeVaultedWalletInput).requestId);
      expect(calls).toEqual([id, id, id, id]);
      h.clock.now = T0 + 7200;
      await h.services.jobs.runTick();
      expect(only()).toMatchObject({ status: 'needs_review', failure_code: 'request_id_expired' });
      expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(4);
      expect(h.commitmentStates(operatorId)).toEqual({ settling: 1 });
    });

    it('a duplicate error with a known order id resolves through getOrder', async () => {
      add(45);
      h.paypal.chargeScripts.push(() => {
        throw apiError(422, ['ORDER_ALREADY_CAPTURED'], { orderId: 'O-D', path: '/v2/checkout/orders/O-D/capture' });
      });
      h.paypal.orderScripts.push(() => completedCharge(45, 'O-D', 'C-D'));
      await h.services.settlements.triggerThreshold(operatorId);
      expect(h.paypal.callsOf('getOrder')).toEqual([['O-D']]);
      expect(only()).toMatchObject({ status: 'completed', paypal_order_id: 'O-D', paypal_capture_id: 'C-D' });
    });

    it('a duplicate error uses the stored order id when there is one', async () => {
      add(45);
      h.paypal.chargeScripts.push(() => {
        throw apiError(422, ['DUPLICATE_INVOICE_ID']);
      });
      h.paypal.orderScripts.push(() => captureWith('DECLINED', 45, 'O-S', 'C-S'));
      // Simulate a stored order id from an earlier attempt.
      const hold = h.paypal.hold('chargeVaultedWallet');
      const run = h.services.settlements.triggerThreshold(operatorId);
      await hold.entered;
      h.db.prepare(`UPDATE settlements SET paypal_order_id = 'O-S'`).run();
      hold.release();
      await run;
      expect(h.paypal.callsOf('getOrder')).toEqual([['O-S']]);
      expect(only()).toMatchObject({ status: 'failed', failure_code: 'declined' });
    });

    it('a duplicate error without an order id goes to needs_review', async () => {
      add(45);
      h.paypal.chargeScripts.push(() => {
        throw apiError(422, ['DUPLICATE_INVOICE_ID']);
      });
      await h.services.settlements.triggerThreshold(operatorId);
      expect(only()).toMatchObject({ status: 'needs_review', failure_code: 'duplicate_without_order' });
      expect(h.paypal.callsOf('getOrder')).toEqual([]);
    });

    it('other errors go to needs_review and are not retried; the unsettled cap keeps the agents blocked', async () => {
      add(45);
      h.paypal.chargeScripts.push(() => {
        throw apiError(400, ['MALFORMED_REQUEST_JSON']);
      });
      await h.services.settlements.triggerThreshold(operatorId);
      expect(only()).toMatchObject({ status: 'needs_review', failure_code: 'paypal_error', failure_reason: 'MALFORMED_REQUEST_JSON' });
      h.clock.now += 3600;
      await h.services.jobs.runTick();
      expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(1);
      expect(h.commitmentStates(operatorId)).toEqual({ settling: 1 });
      const agents = await h.api('GET', '/v1/agents', { key });
      expect((agents.body['agents'] as { blocked: boolean }[])[0]?.blocked).toBe(true);
      const snapshot = await h.services.ledger.snapshot(operatorId, h.clock.now);
      expect(snapshot.unsettled).toBe(45);
    });

    it('never charges more than the sum of the commitments; a capture of another amount needs review', async () => {
      add(30);
      add(15);
      h.paypal.chargeScripts.push((input) => completedCharge(input.amountCents + 1));
      await h.services.settlements.triggerThreshold(operatorId);
      expect((h.paypal.callsOf('chargeVaultedWallet')[0]?.[0] as ChargeVaultedWalletInput).amountCents).toBe(45);
      expect(only()).toMatchObject({ status: 'needs_review', failure_code: 'amount_mismatch' });
    });

    it('recovers a pending settlement with no order id at start-up with the same request id', async () => {
      const id = add(12);
      h.db.prepare(
        `INSERT INTO settlements (id, operator_id, trigger, status, amount, calls_count, paypal_request_id, vault_id_hash, created_at, updated_at)
         VALUES ('stl_crash', ?, 'threshold', 'pending', 12, 1, 'stl_crash', ?, ?, ?)`,
      ).run(operatorId, h.wallet(operatorId).vault_id_hash, T0 - 60, T0 - 60);
      h.db.prepare(`INSERT INTO settlement_items VALUES ('stl_crash', ?, ?, 12)`).run(id, sellerId);
      h.db.prepare(`UPDATE commitments SET state = 'settling', settlement_id = 'stl_crash'`).run();
      await h.services.jobs.runTick();
      expect((h.paypal.callsOf('chargeVaultedWallet')[0]?.[0] as ChargeVaultedWalletInput).requestId).toBe('stl_crash');
      expect(only()).toMatchObject({ id: 'stl_crash', status: 'completed' });
    });

    it.each(['poll first', 'webhook first'])('applies a poll result and a webhook for the same settlement once (%s)', async (order) => {
      add(45);
      h.paypal.chargeScripts.push(() => captureWith('PENDING', 45, 'O-W', 'C-W'));
      await h.services.settlements.triggerThreshold(operatorId);
      const webhook = () =>
        h.api('POST', '/webhooks/paypal', {
          headers: { 'paypal-transmission-sig': 'valid' },
          body: {
            id: `WH-${order}`,
            event_type: 'PAYMENT.CAPTURE.DECLINED',
            resource: { id: 'C-W', status: 'DECLINED', supplementary_data: { related_ids: { order_id: 'O-W' } } },
          },
        });
      h.paypal.orderScripts.push(() => completedCharge(45, 'O-W', 'C-W'));
      const before = h.seen.filter((e) => e.type === 'settlement.updated').length;
      if (order === 'poll first') {
        await h.services.jobs.runTick();
        await webhook();
        expect(only()).toMatchObject({ status: 'completed' });
        expect(h.commitmentStates(operatorId)).toEqual({ settled: 1 });
        expect(h.db.prepare('SELECT outcome FROM webhook_events').get()).toEqual({ outcome: 'already_resolved' });
      } else {
        const hold = h.paypal.hold('getOrder');
        const tick = h.services.jobs.runTick();
        await hold.entered;
        await webhook();
        hold.release();
        await tick;
        expect(only()).toMatchObject({ status: 'failed', failure_code: 'declined' });
        expect(h.commitmentStates(operatorId)).toEqual({ unsettled: 1 });
        expect(h.wallet(operatorId).charge_retry_after).toBe(T0 + 900);
      }
      expect(h.seen.filter((e) => e.type === 'settlement.updated').length - before).toBe(1);
    });

    it('keeps the settlement invariants for every status', async () => {
      const scripts = [
        (input: ChargeVaultedWalletInput) => completedCharge(input.amountCents),
        () => captureWith('DECLINED', 1),
        () => {
          throw apiError(400, ['X']);
        },
      ];
      for (const script of scripts) {
        add(41);
        h.paypal.chargeScripts.push(script);
        h.db.prepare('UPDATE wallets SET charge_retry_after = NULL').run();
        await h.services.settlements.settleManually(operatorId);
        h.checkInvariants();
      }
      add(2);
      h.paypal.chargeScripts.push(() => {
        throw networkError();
      });
      await h.services.settlements.settleManually(operatorId);
      expect(h.settlements(operatorId).map((s) => s.status)).toEqual(['completed', 'failed', 'needs_review', 'pending']);
      expect(h.settlements(operatorId).map((s) => s.amount)).toEqual([41, 41, 82, 2]);
      h.checkInvariants();
    });
  });

  describe('settlement.updated events', () => {
    it('is emitted on claim and on resolution', async () => {
      add(45);
      await h.services.settlements.triggerThreshold(operatorId);
      const id = only().id;
      expect(h.seen.filter((e) => e.type === 'settlement.updated').map((e) => e.data)).toEqual([
        { id, status: 'pending', trigger: 'threshold', amount: 45, callsCount: 1 },
        { id, status: 'completed', trigger: 'threshold', amount: 45, callsCount: 1 },
      ]);
    });
  });
});
