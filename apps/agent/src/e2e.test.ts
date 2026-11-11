/**
 * End to end inside Vitest, with no network beyond localhost: the facilitator harness (fake PayPal),
 * the demo seller (fake AI) started with `startSeller`, and the agent with a scripted Claude.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '@payper402/facilitator/test-support';
import { startSeller, type RunningSeller } from '@payper402/demo-seller';
import { runAgent } from './agent';
import { openSession } from './session';
import { FakeSellerAi, fakeAnthropic, fetchSpy, message, toolUse } from './test-support';

describe('end to end: facilitator + demo seller + agent', () => {
  let h: Harness;
  let seller: RunningSeller;
  let operatorKey: string;
  let operatorId: string;
  let agentId: string;
  let agentKey: ReturnType<Harness['addAgent']>['key'];
  let paymentToken: string;

  beforeEach(async () => {
    h = createHarness();
    ({ operatorId, key: operatorKey } = h.addOperator({ caps: { perCall: 10, daily: 1000, unsettled: 500 } }));
    paymentToken = h.activateWallet(operatorId);
    const sellerAccount = h.addSeller();
    ({ agentId, key: agentKey } = h.addAgent(operatorId));
    seller = await startSeller({ port: 0, facilitatorUrl: await h.url(), sellerApiKey: sellerAccount.key, ai: new FakeSellerAi() });
  });

  afterEach(async () => {
    await seller.close();
    await h.close();
  });

  // The harness clock is fixed unix seconds; commitments must carry the same clock (design spec §4).
  const session = (fetchFn?: typeof fetch) =>
    openSession({
      sellerUrl: seller.url,
      privateKey: agentKey.privateKey,
      budgetCents: 100,
      maxPerCallCents: 10,
      nowSeconds: () => h.clock.now,
      ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    });
  const RATES = { hotelId: 'higashiyama-stone-garden-inn', checkIn: '2027-03-30', checkOut: '2027-04-02' };
  const call = (serviceId: string, params: Record<string, unknown>, reason: string) =>
    toolUse('call_service', { service_id: serviceId, params, reason });
  const finish = (answer: string) => toolUse('finish', { answer, spend_explanation: 'I explained what I paid for.' });

  it('paid calls land in the ledger, a settlement charges exactly the sum, and revocation is refused once', async () => {
    const fake = fakeAnthropic([
      message([toolUse('list_services', {})]),
      message([call('hotel_rates', RATES, 'Rates for the stay')]),
      message([call('review_summary', { hotelId: RATES.hotelId, focus: 'noise at night' }, 'Is it quiet?')]),
      message([call('walking_time', { hotelId: RATES.hotelId, place: 'kiyomizu-dera' }, 'Walking distance')]),
      message([finish('The Stone Garden Inn fits (simulated data).')]),
    ]);
    const run = await runAgent({ task: 'Find me a quiet hotel in Kyoto', session: await session(), anthropic: fake.client });
    expect(run.status).toBe('completed');
    expect(run.report.lines.map((l) => [l.serviceId, l.totalCents])).toEqual([
      ['hotel_rates', 1],
      ['review_summary', 5],
      ['walking_time', 1],
    ]);

    const listed = await h.api('GET', `/v1/commitments?agentId=${agentId}&limit=500`, { key: operatorKey });
    const commitments = listed.body['commitments'] as { id: string; amount: number }[];
    expect(new Set(commitments.map((c) => c.id))).toEqual(new Set(run.report.commitmentIds));
    const paid = run.events.filter((e) => e.type === 'paid');
    for (const event of paid) {
      expect(commitments.find((c) => c.id === event.commitmentId)?.amount).toBe(event.amountCents);
    }

    const settled = await h.api('POST', '/v1/settlements', { key: operatorKey });
    expect(settled.status).toBe(201);
    expect(settled.body['settlement']).toMatchObject({ status: 'completed', amount: 7, callsCount: 3 });
    expect(h.paypal.callsOf('chargeVaultedWallet')).toEqual([[expect.objectContaining({ amountCents: 7 })]]);
    h.checkInvariants();

    // The payer stops the agreement at PayPal; the webhook revokes the wallet.
    const webhook = await h.api('POST', '/webhooks/paypal', {
      headers: { 'paypal-transmission-sig': 'valid', 'paypal-transmission-id': 'tx-e2e' },
      body: { id: 'WH-E2E', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: paymentToken } },
    });
    expect(webhook.status).toBe(200);
    expect(h.wallet(operatorId).status).toBe('stopped_by_payer');

    const spy = fetchSpy();
    const second = fakeAnthropic([
      message([call('hotel_rates', RATES, 'Rates for the stay')]),
      message([call('hotel_rates', { ...RATES, hotelId: 'gion-lantern-house' }, 'Another hotel')]),
      message([finish('Payments were refused: the operator stopped the PayPal link.')]),
    ]);
    const stopped = await runAgent({ task: 'Find me a quiet hotel in Kyoto', session: await session(spy.fetch), anthropic: second.client });
    const refused = stopped.events.filter((e) => e.type === 'refused');
    expect(refused).toEqual([expect.objectContaining({ code: 'wallet_revoked', by: 'facilitator' })]);
    expect(spy.calls).toHaveLength(2);
    const lastResults = (second.requests[2]?.body['messages'] as { content: unknown }[]).at(-1)?.content as { content: string; is_error?: boolean }[];
    expect(lastResults[0]?.is_error).toBe(true);
    expect(JSON.parse(lastResults[0]?.content ?? '{}')).toMatchObject({ ok: false, error: 'payments_blocked' });
    expect(stopped.status).toBe('completed');
    expect(stopped.report.spentCents).toBe(0);
    h.checkInvariants();
  });
});
