import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerifyWebhookSignatureInput } from '@payper402/paypal-client';
import { captureWith, createHarness, T0, type Harness } from './test-support';

const VALID = { 'paypal-transmission-sig': 'valid', 'paypal-transmission-id': 'tx-1' };

describe('PayPal webhooks', () => {
  let h: Harness;
  let operatorId: string;
  let agentId: string;
  let sellerId: string;

  const post = (body: unknown, headers: Record<string, string> = VALID) => h.api('POST', '/webhooks/paypal', { headers, body });
  const events = () => h.db.prepare('SELECT id, event_type, resource_id, outcome FROM webhook_events ORDER BY id').all();

  /** A pending settlement with a PENDING capture C-1 on order O-1. */
  async function pendingSettlement(amount = 45) {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount });
    h.paypal.chargeScripts.push(() => captureWith('PENDING', amount, 'O-1', 'C-1'));
    await h.services.settlements.settleManually(operatorId);
  }

  beforeEach(() => {
    h = createHarness();
    operatorId = h.addOperator().operatorId;
    agentId = h.addAgent(operatorId).agentId;
    sellerId = h.addSeller().sellerId;
    h.activateWallet(operatorId, 'PT-W');
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers 503 without a webhook id', async () => {
    const plain = createHarness();
    // The services share this config object, so removing the id here disables webhooks.
    delete (plain.config as { paypalWebhookId?: string }).paypalWebhookId;
    try {
      const res = await plain.api('POST', '/webhooks/paypal', { headers: VALID, body: { id: 'WH-1', event_type: 'X' } });
      expect(res.status).toBe(503);
      expect(res.body['error']).toBe('webhooks_disabled');
      expect(plain.paypal.callsOf('verifyWebhookSignature')).toEqual([]);
    } finally {
      await plain.close();
    }
  });

  it('passes the raw body verbatim to verification', async () => {
    const raw = '{"id":"WH-raw",  "event_type":"SOMETHING.ELSE","resource":{"x":1.50}}';
    await post(raw);
    const input = h.paypal.callsOf('verifyWebhookSignature')[0]?.[0] as VerifyWebhookSignatureInput;
    expect(input.rawBody).toBe(raw);
    expect(input.webhookId).toBe('WH-TEST');
    expect(input.headers['paypal-transmission-id']).toBe('tx-1');
  });

  it('rejects a bad signature with 400 and stores no event; the genuine event is processed afterwards', async () => {
    const event = { id: 'WH-D', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'PT-W' } };
    const bad = await post(event, { 'paypal-transmission-sig': 'forged', 'paypal-transmission-id': 'tx-bad' });
    expect(bad.status).toBe(400);
    expect(bad.body['error']).toBe('invalid_signature');
    expect(events()).toEqual([]);
    expect(h.wallet(operatorId).status).toBe('active');
    expect(h.db.prepare(`SELECT action, resource_id FROM audit_log WHERE action = 'webhook.signature_failed'`).get()).toEqual({
      action: 'webhook.signature_failed',
      resource_id: 'tx-bad',
    });
    const good = await post(event);
    expect(good.status).toBe(200);
    expect(h.wallet(operatorId).status).toBe('stopped_by_payer');
    expect(events()).toEqual([
      { id: 'WH-D', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource_id: h.services.ctx.box.lookupHash('PT-W'), outcome: 'wallet_revoked' },
    ]);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM webhook_events').all())).not.toContain('PT-W');
  });

  it('acknowledges a duplicate verified event without effect', async () => {
    await pendingSettlement();
    const event = { id: 'WH-C', event_type: 'PAYMENT.CAPTURE.PENDING', resource: { id: 'C-1' } };
    expect((await post(event)).body).toEqual({ ok: true });
    const again = await post(event);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(events()).toHaveLength(1);
  });

  it('PAYMENT.CAPTURE.COMPLETED completes the settlement with fee and net', async () => {
    await pendingSettlement();
    await post({
      id: 'WH-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'C-1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '0.45' },
        seller_receivable_breakdown: { paypal_fee: { value: '0.51' }, net_amount: { value: '0.00' } },
      },
    });
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'completed', fee: 51, net: 0, paypal_capture_id: 'C-1' });
    expect(h.commitmentStates(operatorId)).toEqual({ settled: 1 });
    expect(events()).toEqual([expect.objectContaining({ outcome: 'settlement_completed' })]);
  });

  it('finds the settlement by order id when the capture id is unknown', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 45 });
    h.paypal.chargeScripts.push(() => ({ orderId: 'O-9', orderStatus: 'COMPLETED', capture: { id: 'C-9', status: 'PENDING', amountCents: 45 } }));
    await h.services.settlements.settleManually(operatorId);
    h.db.prepare('UPDATE settlements SET paypal_capture_id = NULL').run();
    await post({
      id: 'WH-2',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'C-other', status: 'COMPLETED', amount: { value: '0.45' }, supplementary_data: { related_ids: { order_id: 'O-9' } } },
    });
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'completed' });
  });

  it.each(['PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED'])('%s applies the decline outcome', async (type) => {
    await pendingSettlement();
    await post({ id: 'WH-3', event_type: type, resource: { id: 'C-1', status: 'DECLINED' } });
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'failed', failure_code: 'declined', failure_reason: type });
    expect(h.commitmentStates(operatorId)).toEqual({ unsettled: 1 });
    expect(h.wallet(operatorId).charge_retry_after).toBe(T0 + 900);
  });

  it('PAYMENT.CAPTURE.PENDING updates capture_status', async () => {
    await pendingSettlement();
    h.db.prepare('UPDATE settlements SET capture_status = NULL').run();
    await post({ id: 'WH-4', event_type: 'PAYMENT.CAPTURE.PENDING', resource: { id: 'C-1', status: 'PENDING' } });
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'pending', capture_status: 'PENDING' });
  });

  it.each([
    ['PAYMENT.CAPTURE.REFUNDED', 'capture.refunded'],
    ['PAYMENT.CAPTURE.REVERSED', 'capture.reversed'],
  ])('%s is written to the audit log only', async (type, action) => {
    await pendingSettlement();
    await post({ id: 'WH-5', event_type: type, resource: { id: 'C-1' } });
    expect(h.db.prepare('SELECT action, resource_id FROM audit_log WHERE action = ?').get(action)).toEqual({ action, resource_id: 'C-1' });
    expect(h.settlements(operatorId)[0]).toMatchObject({ status: 'pending' });
    expect(events()).toEqual([expect.objectContaining({ outcome: 'audited' })]);
  });

  it('stores an unknown event and ignores it', async () => {
    const res = await post({ id: 'WH-6', event_type: 'CUSTOMER.SOMETHING', resource: { id: 'R-1' } });
    expect(res.status).toBe(200);
    expect(events()).toEqual([{ id: 'WH-6', event_type: 'CUSTOMER.SOMETHING', resource_id: 'R-1', outcome: 'ignored' }]);
  });

  it('records handling errors in the outcome and still answers 200', async () => {
    h.services.settlements.applyCaptureWebhook = async () => {
      throw new Error('handler bug');
    };
    const res = await post({ id: 'WH-7', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C-1' } });
    expect(res.status).toBe(200);
    expect(events()).toEqual([expect.objectContaining({ id: 'WH-7', outcome: 'error: handler bug' })]);
  });

  it('reports a capture event for an unknown settlement', async () => {
    await post({ id: 'WH-8', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C-unknown', status: 'COMPLETED', amount: { value: '1.00' } } });
    expect(events()).toEqual([expect.objectContaining({ outcome: 'settlement_not_found' })]);
  });

  it('rejects a verified body without an id', async () => {
    const res = await post({ event_type: 'X' });
    expect(res.status).toBe(400);
    expect(events()).toEqual([]);
  });
});
