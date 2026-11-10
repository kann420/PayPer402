import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, networkError, type Harness } from './test-support';

describe('GET /v1/settlements/:id/verify', () => {
  let h: Harness;
  let operatorId: string;
  let key: string;
  let agentId: string;
  let sellerId: string;

  const settle = async (amount: number): Promise<{ id: string; paypalCaptureId: string | null; paypalOrderId: string | null }> => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount });
    const res = await h.api('POST', '/v1/settlements', { key });
    expect(res.status).toBe(201);
    return res.body['settlement'] as { id: string; paypalCaptureId: string | null; paypalOrderId: string | null };
  };
  const verify = (id: string, k = key) => h.api('GET', `/v1/settlements/${id}/verify`, { key: k });

  beforeEach(() => {
    h = createHarness();
    ({ operatorId, key } = h.addOperator({ caps: { perCall: 10, daily: 1000, unsettled: 500 } }));
    agentId = h.addAgent(operatorId).agentId;
    sellerId = h.addSeller().sellerId;
    h.activateWallet(operatorId, 'PT-V');
  });
  afterEach(async () => {
    await h.close();
  });

  it('verifies a completed charge against the capture PayPal reports', async () => {
    const s = await settle(8);
    const res = await verify(s.id);
    expect(res.status).toBe(200);
    const v = res.body['verification'] as Record<string, unknown>;
    expect(v).toMatchObject({
      settlementId: s.id,
      verified: true,
      paypal: { captureId: s.paypalCaptureId, status: 'COMPLETED', amount: 8, currency: 'USD', invoiceId: s.id, orderId: s.paypalOrderId },
    });
    expect((v['checks'] as { name: string; ok: boolean }[]).map((c) => [c.name, c.ok])).toEqual([
      ['capture_found', true],
      ['completed', true],
      ['amount', true],
      ['currency', true],
      ['invoice', true],
      ['order', true],
    ]);
    expect(h.paypal.callsOf('getCapture')).toEqual([[s.paypalCaptureId]]);
  });

  it('fails the check when PayPal disagrees with the ledger', async () => {
    const s = await settle(8);
    const capture = h.paypal.captures.get(s.paypalCaptureId ?? '');
    if (!capture) throw new Error('expected a capture');
    h.paypal.captures.set(capture.id, { ...capture, amountCents: 9, status: 'REFUNDED', invoiceId: 'stl_other' });
    const v = (await verify(s.id)).body['verification'] as { verified: boolean; checks: { name: string; ok: boolean; expected: string; actual: string | null }[] };
    expect(v.verified).toBe(false);
    expect(v.checks.filter((c) => !c.ok)).toEqual([
      { name: 'completed', ok: false, expected: 'COMPLETED', actual: 'REFUNDED' },
      { name: 'amount', ok: false, expected: '$0.08', actual: '$0.09' },
      { name: 'invoice', ok: false, expected: s.id, actual: 'stl_other' },
    ]);
  });

  it('reports a capture PayPal does not know as not verified', async () => {
    const s = await settle(5);
    h.paypal.captures.clear();
    const res = await verify(s.id);
    expect(res.status).toBe(200);
    expect(res.body['verification']).toMatchObject({
      verified: false,
      paypal: null,
      checks: [{ name: 'capture_found', ok: false, expected: s.paypalCaptureId, actual: null }],
    });
  });

  it('answers 502 when PayPal cannot be reached', async () => {
    const s = await settle(5);
    h.paypal.getCaptureError = networkError();
    const res = await verify(s.id);
    expect(res.status).toBe(502);
    expect(res.body['error']).toBe('paypal_unavailable');
  });

  it('answers 409 for a charge without a capture', async () => {
    h.addCommitment({ operatorId, agentId, payTo: sellerId, amount: 4 });
    h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    const pending = (await h.api('POST', '/v1/settlements', { key })).body['settlement'] as { id: string; paypalCaptureId: string | null };
    expect(pending.paypalCaptureId).toBeNull();
    const res = await verify(pending.id);
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('not_captured');
    expect(h.paypal.callsOf('getCapture')).toEqual([]);
  });

  it("answers 404 for another operator's charge and makes no PayPal call", async () => {
    const s = await settle(5);
    const other = h.addOperator();
    expect((await verify(s.id, other.key)).status).toBe(404);
    expect((await verify('stl_missing')).status).toBe(404);
    expect(h.paypal.callsOf('getCapture')).toEqual([]);
  });

  it('limits checks to 20 a minute per operator', async () => {
    const s = await settle(5);
    for (let i = 0; i < 20; i++) expect((await verify(s.id)).status).toBe(200);
    const limited = await verify(s.id);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    h.clock.now += 61;
    expect((await verify(s.id)).status).toBe(200);
  });
});
