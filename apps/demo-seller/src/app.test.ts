import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOTELS } from './data/kyoto';
import { startSeller, SellerStartError } from './server';
import { SERVICES } from './services';
import { PAY_TO, call, paidCall, startTestSeller, type CallOptions, type TestSeller } from './test-support';

const STAY = { checkIn: '2027-03-30', checkOut: '2027-04-02' };
const STONE_GARDEN = 'higashiyama-stone-garden-inn';

const validCalls: Record<string, CallOptions> = {
  hotel_search: { query: { city: 'kyoto', ...STAY } },
  hotel_rates: { query: { hotelId: STONE_GARDEN, ...STAY } },
  review_summary: { body: { hotelId: STONE_GARDEN, focus: 'noise at night' } },
  walking_time: { query: { hotelId: STONE_GARDEN, place: 'kiyomizu-dera' } },
  price_forecast: { query: { city: 'kyoto', ...STAY } },
};

describe('demo seller over HTTP', () => {
  let seller: TestSeller;

  beforeEach(async () => {
    seller = await startTestSeller();
  });

  afterEach(async () => {
    await seller.close();
  });

  it.each(SERVICES.map((s) => [s.id, s] as const))('%s answers an unpaid request with 402 and the catalog price', async (id, service) => {
    const res = await call(seller, service.method, service.path, validCalls[id]);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '');
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: 'batch-settlement',
        network: 'paypal:sandbox',
        asset: 'USD',
        amount: String(service.priceCents),
        payTo: PAY_TO,
      }),
    ]);
    expect(seller.ledger.size).toBe(0);
  });

  it.each(SERVICES.map((s) => [s.id, s] as const))('%s succeeds when paid and the ledger records the amount', async (id, service) => {
    const res = await paidCall(seller, service.method, service.path, validCalls[id]);
    expect(res.status).toBe(200);
    const settled = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '');
    expect(settled).toMatchObject({ success: true, amount: String(service.priceCents) });
    expect(seller.ledger.all()).toEqual([expect.objectContaining({ id: settled.transaction, amount: service.priceCents, payTo: PAY_TO })]);
  });

  const search = async (query: Record<string, string>) => {
    const res = await paidCall(seller, 'GET', '/v1/hotels/search', { query: { city: 'kyoto', ...STAY, ...query } });
    return (await res.json()) as { hotels: { id: string; area: string; priceNote: string }[]; seasonNote?: string; source: string; simulated: boolean };
  };

  it('hotel search answers the hotels in or near the area for the dates', async () => {
    const body = await search({ area: 'gion' });
    expect(body).toMatchObject({ city: 'kyoto', ...STAY, source: 'Acme Data demo feed (simulated)', simulated: true });
    // Gion itself, plus hotels within a 15-minute walk of Yasaka Shrine (the intended answer is in Higashiyama).
    expect(body.hotels.map((h) => h.id)).toEqual([
      'yasaka-courtyard-hotel',
      'higashiyama-stone-garden-inn',
      'kamo-river-suites',
      'gion-lantern-house',
      'shijo-riverside-lodge',
    ]);
    expect(body.hotels[0]?.priceNote).toBe('Indicative off-season price. Check Room Rates for your dates.');
    expect(body.seasonNote).toMatch(/^Cherry blossom season/);
  });

  it('hotel search filters by indicative price and caps at 6 results', async () => {
    expect((await search({ maxPricePerNight: '120' })).hotels.map((h) => h.id)).toEqual(['kyoto-station-garden-hotel', 'shijo-riverside-lodge']);
    const all = (await search({})).hotels;
    expect(all).toHaveLength(6);
    expect(all.map((h) => h.id)).not.toContain('shijo-riverside-lodge');
    expect((await search({ area: 'arashiyama' })).hotels.map((h) => h.id)).toEqual(['arashiyama-bamboo-retreat']);
  });

  it('room rates answer the nights, the total and the policy', async () => {
    const res = await paidCall(seller, 'GET', '/v1/hotels/rates', validCalls['hotel_rates']);
    const body = (await res.json()) as { nights: { date: string; pricePerNight: number }[]; total: number; averagePerNight: number };
    expect(body).toMatchObject({
      hotelId: STONE_GARDEN,
      name: 'Higashiyama Stone Garden Inn',
      currency: 'USD',
      available: true,
      cancellation: 'Free cancellation until 7 days before check-in.',
      simulated: true,
    });
    expect(body.nights.map((n) => n.date)).toEqual(['2027-03-30', '2027-03-31', '2027-04-01']);
    expect(body.total).toBe(body.nights.reduce((sum, n) => sum + n.pricePerNight, 0));
    expect(body.averagePerNight).toBeLessThanOrEqual(250);
  });

  it('review summary passes the hotel reviews and the focus to the AI', async () => {
    const res = await paidCall(seller, 'POST', '/v1/hotels/reviews/summary', validCalls['review_summary']);
    expect(await res.json()).toMatchObject({
      hotelId: STONE_GARDEN,
      name: 'Higashiyama Stone Garden Inn',
      reviewCount: 5,
      focus: 'noise at night',
      summary: 'Summary of 5 reviews of Higashiyama Stone Garden Inn on noise at night.',
      words: 13,
      simulated: true,
    });
    expect(seller.ai.calls).toEqual([
      {
        method: 'summarizeReviews',
        input: { hotelName: 'Higashiyama Stone Garden Inn', reviews: HOTELS[STONE_GARDEN].reviews, focus: 'noise at night', maxWords: 90 },
      },
    ]);
  });

  it('review summary works without a focus', async () => {
    const res = await paidCall(seller, 'POST', '/v1/hotels/reviews/summary', { body: { hotelId: 'gion-lantern-house' } });
    expect(await res.json()).toMatchObject({ hotelId: 'gion-lantern-house', focus: null, summary: 'Summary of 5 reviews of Gion Lantern House.' });
    expect(seller.ai.calls[0]?.input).not.toHaveProperty('focus');
  });

  it('walking time answers the distance and minutes', async () => {
    const res = await paidCall(seller, 'GET', '/v1/places/walk', validCalls['walking_time']);
    const body = (await res.json()) as { minutes: number; distanceKm: number };
    expect(body).toMatchObject({ hotelId: STONE_GARDEN, place: 'kiyomizu-dera', placeName: 'Kiyomizu-dera', simulated: true });
    expect(body.minutes).toBeLessThanOrEqual(10);
    expect(body.distanceKm).toBeGreaterThan(0);
  });

  it('price forecast answers one index per night', async () => {
    const res = await paidCall(seller, 'GET', '/v1/hotels/forecast', validCalls['price_forecast']);
    const body = (await res.json()) as { dailyIndex: number[]; analystNote: string; outlook: string };
    expect(body.dailyIndex).toEqual([150, 150, 150]);
    expect(body.analystNote).toMatch(/^Our view/);
    expect(body.outlook).toContain('April 5');
  });

  describe('charging rule: nothing is recorded below a 2xx', () => {
    it('an invalid hotel id answers 400 after a valid payment', async () => {
      const res = await paidCall(seller, 'GET', '/v1/hotels/rates', { query: { hotelId: 'no-such-hotel', ...STAY } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed', issues: [expect.objectContaining({ path: 'hotelId' })] });
      expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
      expect(seller.ledger.size).toBe(0);
    });

    it('an over-long focus answers 400 and the AI is not called', async () => {
      const res = await paidCall(seller, 'POST', '/v1/hotels/reviews/summary', { body: { hotelId: STONE_GARDEN, focus: 'x'.repeat(81) } });
      expect(res.status).toBe(400);
      expect(seller.ai.calls).toHaveLength(0);
      expect(seller.ledger.size).toBe(0);
    });

    it.each([
      ['a bad format', { checkIn: '30-03-2027', checkOut: '2027-04-02' }, 'checkIn'],
      ['an impossible date', { checkIn: '2027-02-30', checkOut: '2027-04-02' }, 'checkIn'],
      ['a check-out before check-in', { checkIn: '2027-04-02', checkOut: '2027-03-30' }, 'checkOut'],
      ['a check-out equal to check-in', { checkIn: '2027-03-30', checkOut: '2027-03-30' }, 'checkOut'],
      ['more than 14 nights', { checkIn: '2027-03-30', checkOut: '2027-04-14' }, 'checkOut'],
    ])('%s answers 400 validation_failed', async (_label, dates, path) => {
      const res = await paidCall(seller, 'GET', '/v1/hotels/rates', { query: { hotelId: STONE_GARDEN, ...dates } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed', issues: [expect.objectContaining({ path })] });
      expect(seller.ledger.size).toBe(0);
    });

    it('an AI failure answers 503 ai_unavailable and nothing is charged', async () => {
      seller.ai.fail = true;
      const res = await paidCall(seller, 'POST', '/v1/hotels/reviews/summary', validCalls['review_summary']);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'ai_unavailable' });
      expect(seller.ledger.size).toBe(0);
    });

    it('a malformed JSON body answers 400 invalid_json before payment', async () => {
      const res = await call(seller, 'POST', '/v1/hotels/reviews/summary', { rawBody: '{"hotelId": ' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json', message: 'The request body is not valid JSON' });
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(seller.ledger.size).toBe(0);
    });

    it('a body over 32 KB answers 413 body_too_large before payment', async () => {
      const res = await call(seller, 'POST', '/v1/hotels/reviews/summary', { body: { hotelId: STONE_GARDEN, focus: 'a'.repeat(33 * 1024) } });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'body_too_large' });
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(seller.ledger.size).toBe(0);
    });

    it('a handler that throws answers 500 with no stack trace or details', async () => {
      // A reply that is not a string makes the handler fail after payment was verified.
      seller.ai.summarizeReviews = async () => undefined as never;
      const res = await paidCall(seller, 'POST', '/v1/hotels/reviews/summary', validCalls['review_summary']);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error', message: 'Internal error' });
      expect(seller.ledger.size).toBe(0);
    });
  });

  it('answers an unknown route with 404 not_found', async () => {
    const res = await call(seller, 'GET', '/v1/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found' });
    expect((await call(seller, 'GET', '/v1/hotels/book')).status).toBe(404);
    expect((await call(seller, 'GET', '/news/anything')).status).toBe(404);
  });

  it('serves the catalog and /healthz for free', async () => {
    const catalogRes = await call(seller, 'GET', '/v1/catalog');
    expect(catalogRes.status).toBe(200);
    const catalog = (await catalogRes.json()) as { seller: unknown; services: { id: string }[] };
    expect(catalog.seller).toEqual({ name: 'Acme Data', payTo: PAY_TO });
    expect(catalog.services.map((s) => s.id)).toEqual(['hotel_search', 'hotel_rates', 'review_summary', 'walking_time', 'price_forecast']);
    expect(await (await call(seller, 'GET', '/healthz')).json()).toEqual({ ok: true });
    expect(seller.ledger.size).toBe(0);
  });
});

describe('startSeller', () => {
  it('fails with a clear error when /v1/seller answers 401', async () => {
    const fetch401 = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    const started = startSeller({
      port: 0,
      facilitatorUrl: 'http://facilitator.test',
      sellerApiKey: `pp402_sel_${'a'.repeat(43)}`,
      ai: { summarizeReviews: async () => '' },
      fetch: fetch401,
    });
    await expect(started).rejects.toBeInstanceOf(SellerStartError);
    await expect(started).rejects.toThrow('The facilitator rejected the seller API key (HTTP 401)');
  });
});
