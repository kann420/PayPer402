import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { decodePaymentRequired, sampleRequest } from '../probe';
import { body, createWebHarness, type WebHarness } from '../test-support';
import { createProbeHandler } from './seller';
import { createSessionHandler } from './session';

describe('probe samples', () => {
  it('uses fixed sample params per service: the default stay at the sample hotel', () => {
    const stay = { checkIn: '2027-03-30', checkOut: '2027-04-02' };
    const hotelId = 'higashiyama-stone-garden-inn';
    expect(sampleRequest('hotel_search')).toEqual({ query: { city: 'kyoto', ...stay } });
    expect(sampleRequest('hotel_rates')).toEqual({ query: { hotelId, ...stay } });
    expect(sampleRequest('review_summary')).toEqual({ body: { hotelId, focus: 'noise at night' } });
    expect(sampleRequest('walking_time')).toEqual({ query: { hotelId, place: 'kiyomizu-dera' } });
    expect(sampleRequest('price_forecast')).toEqual({ query: { city: 'kyoto', ...stay } });
    expect(sampleRequest('other')).toBeUndefined();
  });

  it('decodes the PAYMENT-REQUIRED header', () => {
    const header = Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64');
    expect(decodePaymentRequired(header)).toEqual({ x402Version: 2 });
    expect(decodePaymentRequired('%%%')).toBeUndefined();
    expect(decodePaymentRequired(null)).toBeUndefined();
  });
});

describe('GET /api/seller/probe/:serviceId (real seller app, fake AI, harness)', () => {
  let w: WebHarness;
  beforeEach(async () => {
    w = await createWebHarness({ withSeller: true });
  });
  afterEach(async () => {
    await w.close();
  });

  const probe = (id: string, cookie?: string | null) => createProbeHandler(w.deps)(w.request(`/api/seller/probe/${id}`, cookie === undefined ? {} : { cookie }), id);

  it('needs a valid session', async () => {
    const res = await probe('hotel_rates', null);
    expect(res.status).toBe(401);
  });

  it('answers 402 with a decoded batch-settlement / paypal:sandbox / USD requirement, for every service', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    for (const [id, cents] of [
      ['hotel_search', '2'],
      ['hotel_rates', '1'],
      ['review_summary', '5'],
      ['walking_time', '1'],
      ['price_forecast', '25'],
    ] as const) {
      const res = await probe(id);
      expect(res.status, id).toBe(200);
      const json = (await body(res)) as { status: number; headers: Record<string, string | null>; decoded: { x402Version: number; accepts: Record<string, unknown>[] } };
      expect(json.status).toBe(402);
      expect(json.headers['payment-required']).toBeTruthy();
      expect(json.decoded.x402Version).toBe(2);
      expect(json.decoded.accepts[0]).toMatchObject({ scheme: 'batch-settlement', network: 'paypal:sandbox', asset: 'USD', amount: cents, payTo: w.sellerId });
    }
    // No paid call reached the ledger.
    expect((w.h.db.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(0);
  });

  it('answers 404 for an unknown service', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    expect((await probe('nope')).status).toBe(404);
  });

  it('answers 429 once a client has made 30 probes in the minute', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    // Without WEB_TRUST_PROXY every request shares the client key 'all' (design spec §15.3).
    for (let i = 0; i < 30; i++) w.deps.limits.probesPerClient.hit('all');
    const limited = await probe('hotel_rates');
    expect(limited.status).toBe(429);
    expect(await body(limited)).toMatchObject({ error: 'probe_limit' });
  });
});
