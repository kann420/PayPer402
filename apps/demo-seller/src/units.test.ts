import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { priceToCents } from '@payper402/scheme-paypal';
import { SELLER_AI_BETAS, REVIEWS_SYSTEM, createClaudeSellerAi, SellerAiError } from './ai';
import { ConfigError, loadSellerConfig } from './config';
import { HOTELS, HOTEL_IDS, PLACES, inSeason, nightlyPrice, ratesFor, roomsOn, stayNights, walkBetween, type HotelId } from './data/kyoto';
import { SERVICES, catalog, forecastQuery, ratesQuery, reviewBody, routesConfig, searchQuery } from './services';

const CHECK_IN = '2027-03-30';
const CHECK_OUT = '2027-04-02';

describe('services table', () => {
  it('every route config price equals the catalog price, and every service is protected', () => {
    const routes = routesConfig('sel_x');
    const listed = catalog({ name: 'Acme Data', payTo: 'sel_x' });
    expect(Object.keys(routes).sort()).toEqual(SERVICES.map((s) => `${s.method} ${s.path}`).sort());
    for (const service of listed.services) {
      const route = routes[`${service.method} ${service.path}`];
      expect(route).toBeDefined();
      const accepts = route?.accepts;
      if (!accepts || Array.isArray(accepts)) throw new Error('expected one payment option');
      expect(accepts).toMatchObject({ scheme: 'batch-settlement', network: 'paypal:sandbox', payTo: 'sel_x' });
      if (typeof accepts.price === 'function') throw new Error('expected a static price');
      expect(priceToCents(accepts.price)).toBe(service.priceCents);
      expect(route).toMatchObject({ description: service.description, mimeType: 'application/json' });
    }
  });

  it('lists exactly the five services at the design-spec prices', () => {
    expect(SERVICES.map((s) => [s.id, s.method, s.path, s.priceCents])).toEqual([
      ['hotel_search', 'GET', '/v1/hotels/search', 2],
      ['hotel_rates', 'GET', '/v1/hotels/rates', 1],
      ['review_summary', 'POST', '/v1/hotels/reviews/summary', 5],
      ['walking_time', 'GET', '/v1/places/walk', 1],
      ['price_forecast', 'GET', '/v1/hotels/forecast', 25],
    ]);
    expect(catalog({ name: 'Acme Data', payTo: 'sel_x' })).toMatchObject({
      seller: { name: 'Acme Data', payTo: 'sel_x' },
      scheme: 'batch-settlement',
      network: 'paypal:sandbox',
      asset: 'USD',
    });
  });

  it('declares required params that exist in the param table', () => {
    for (const service of SERVICES) {
      for (const name of service.required) expect(service.params[name], `${service.id}.${name}`).toBeDefined();
    }
  });
});

describe('season and nightly price', () => {
  it('opens the cherry blossom window on March 25 and closes it after April 10', () => {
    expect(inSeason('2027-03-24')).toBe(false);
    expect(inSeason('2027-03-25')).toBe(true);
    expect(inSeason('2027-04-10')).toBe(true);
    expect(inSeason('2027-04-11')).toBe(false);
  });

  it('is deterministic per hotel and night, within 3% of base times the season factor', () => {
    for (const id of HOTEL_IDS) {
      for (const date of stayNights('2027-03-20', '2027-04-15')) {
        const price = nightlyPrice(id, date);
        expect(price).toBe(nightlyPrice(id, date));
        const expected = HOTELS[id].base * (inSeason(date) ? 1.5 : 1);
        expect(price).toBeGreaterThanOrEqual(Math.floor(expected * 0.97));
        expect(price).toBeLessThanOrEqual(Math.ceil(expected * 1.03));
        expect(Number.isInteger(price)).toBe(true);
      }
    }
  });

  it('lists the nights from check-in up to, not including, check-out', () => {
    expect(stayNights(CHECK_IN, CHECK_OUT)).toEqual(['2027-03-30', '2027-03-31', '2027-04-01']);
    expect(stayNights('2027-02-27', '2027-03-02')).toEqual(['2027-02-27', '2027-02-28', '2027-03-01']);
  });
});

describe('rooms left', () => {
  it('is 1 to 6 and the minimum across the stay', () => {
    const id: HotelId = 'gion-lantern-house';
    const nights = stayNights('2027-05-01', '2027-05-15');
    for (const date of nights) {
      expect(roomsOn(id, date)).toBeGreaterThanOrEqual(1);
      expect(roomsOn(id, date)).toBeLessThanOrEqual(6);
    }
    expect(ratesFor(id, '2027-05-01', '2027-05-15').roomsLeft).toBe(Math.min(...nights.map((date) => roomsOn(id, date))));
  });

  it('reports the sold-out hotel as unavailable when any night is in the season', () => {
    const inside = ratesFor('kamo-river-suites', CHECK_IN, CHECK_OUT);
    expect(inside).toMatchObject({ roomsLeft: 0, available: false });
    expect(ratesFor('kamo-river-suites', '2027-04-09', '2027-04-12')).toMatchObject({ roomsLeft: 0, available: false });
    expect(ratesFor('kamo-river-suites', '2027-03-22', '2027-03-25')).toMatchObject({ available: true });
    expect(ratesFor('kamo-river-suites', '2027-05-01', '2027-05-03').roomsLeft).toBeGreaterThan(0);
  });

  it('adds a season note only for stays that touch the season', () => {
    expect(ratesFor('gion-lantern-house', CHECK_IN, CHECK_OUT).seasonNote).toMatch(/^Cherry blossom season/);
    expect(ratesFor('gion-lantern-house', '2027-05-01', '2027-05-03').seasonNote).toBeUndefined();
  });
});

describe('design invariants for the default stay', () => {
  const rates = (id: HotelId) => ratesFor(id, CHECK_IN, CHECK_OUT);

  it('keeps the story roles of the fixtures', () => {
    expect(rates('higashiyama-stone-garden-inn').averagePerNight).toBeLessThanOrEqual(250);
    expect(rates('higashiyama-stone-garden-inn').averagePerNight).toBeGreaterThan(200);
    expect(rates('gion-lantern-house').averagePerNight).toBeLessThanOrEqual(250);
    expect(rates('yasaka-courtyard-hotel').averagePerNight).toBeGreaterThan(250);
    expect(rates('kamo-river-suites').available).toBe(false);
    const available = HOTEL_IDS.map(rates).filter((r) => r.available);
    const cheapest = available.reduce((a, b) => (b.total < a.total ? b : a));
    expect(cheapest.hotelId).toBe('shijo-riverside-lodge');
  });

  it('puts the right answer within 10 minutes of Kiyomizu-dera and the station hotel far from Gion', () => {
    expect(walkBetween('higashiyama-stone-garden-inn', 'kiyomizu-dera').minutes).toBeLessThanOrEqual(10);
    expect(walkBetween('kyoto-station-garden-hotel', 'gion-shijo-station').minutes).toBeGreaterThanOrEqual(30);
  });
});

describe('walking time', () => {
  it('is haversine times 1.3 at 80 m per minute, rounded up, with the distance in km to one decimal', () => {
    const hotel = HOTELS['higashiyama-stone-garden-inn'];
    const place = PLACES['kiyomizu-dera'];
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const a = Math.sin(rad(place.lat - hotel.lat) / 2) ** 2 + Math.cos(rad(hotel.lat)) * Math.cos(rad(place.lat)) * Math.sin(rad(place.lng - hotel.lng) / 2) ** 2;
    const metres = 2 * 6_371_000 * Math.asin(Math.sqrt(a)) * 1.3;
    expect(walkBetween(hotel.id, place.id)).toEqual({ distanceKm: Math.round(metres / 100) / 10, minutes: Math.ceil(metres / 80) });
  });
});

describe('request validation', () => {
  it('accepts the default stay and rejects bad dates and stays', () => {
    expect(ratesQuery.safeParse({ hotelId: 'gion-lantern-house', checkIn: CHECK_IN, checkOut: CHECK_OUT }).success).toBe(true);
    expect(forecastQuery.safeParse({ city: 'kyoto', checkIn: CHECK_IN, checkOut: '2027-04-13' }).success).toBe(true);
    for (const [checkIn, checkOut] of [
      ['2027-3-30', CHECK_OUT],
      ['2027-02-29', CHECK_OUT],
      [CHECK_OUT, CHECK_IN],
      [CHECK_IN, CHECK_IN],
      [CHECK_IN, '2027-04-14'],
    ] as const) {
      expect(ratesQuery.safeParse({ hotelId: 'gion-lantern-house', checkIn, checkOut }).success, `${checkIn}..${checkOut}`).toBe(false);
    }
  });

  it('checks search filters and the price bounds', () => {
    const base = { city: 'kyoto', checkIn: CHECK_IN, checkOut: CHECK_OUT };
    expect(searchQuery.parse({ ...base, area: 'gion', maxPricePerNight: '250' })).toMatchObject({ area: 'gion', maxPricePerNight: 250 });
    expect(searchQuery.safeParse({ ...base, area: 'tokyo' }).success).toBe(false);
    expect(searchQuery.safeParse({ ...base, maxPricePerNight: '19' }).success).toBe(false);
    expect(searchQuery.safeParse({ ...base, maxPricePerNight: '2001' }).success).toBe(false);
    expect(searchQuery.safeParse({ ...base, maxPricePerNight: '99.5' }).success).toBe(false);
    expect(searchQuery.safeParse({ ...base, city: 'osaka' }).success).toBe(false);
  });

  it('limits the review focus to 80 characters', () => {
    expect(reviewBody.safeParse({ hotelId: 'gion-lantern-house', focus: 'a'.repeat(80) }).success).toBe(true);
    expect(reviewBody.safeParse({ hotelId: 'gion-lantern-house', focus: 'a'.repeat(81) }).success).toBe(false);
    expect(reviewBody.safeParse({ hotelId: 'gion-lantern-house' }).success).toBe(true);
  });
});

describe('fixtures', () => {
  it('has seven fictional hotels with five reviews each', () => {
    expect(HOTEL_IDS).toHaveLength(7);
    for (const id of HOTEL_IDS) {
      const hotel = HOTELS[id];
      expect(hotel.id).toBe(id);
      expect(hotel.reviews).toHaveLength(5);
      expect(hotel.rating).toBeGreaterThanOrEqual(3.6);
      expect(hotel.rating).toBeLessThanOrEqual(4.8);
      expect(hotel.tags.length).toBeGreaterThanOrEqual(2);
      expect(hotel.tags.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('config', () => {
  const key = `pp402_sel_${'a'.repeat(43)}`;

  it('applies the defaults', () => {
    expect(loadSellerConfig({ SELLER_API_KEY: key })).toEqual({
      port: 4021,
      publicUrl: 'http://localhost:4021',
      facilitatorUrl: 'http://localhost:4020',
      sellerApiKey: key,
      anthropicModel: 'claude-opus-5-5',
    });
  });

  it('requires the seller key and never echoes values', () => {
    expect(() => loadSellerConfig({})).toThrow(ConfigError);
    try {
      loadSellerConfig({ SELLER_API_KEY: 'pp402_sel_short-secret' });
    } catch (err) {
      expect(String(err)).toContain('SELLER_API_KEY');
      expect(String(err)).not.toContain('short-secret');
    }
  });
});

interface Captured {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeClient(reply: { status: number; body: Record<string, unknown> }) {
  const captured: Captured[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    captured.push({ headers, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  return { client: new Anthropic({ apiKey: 'sk-ant-test-not-a-key', fetch, maxRetries: 0 }), captured };
}

const messageBody = (content: Record<string, unknown>[], stopReason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const reviewInput = { hotelName: 'Inn "A"', reviews: ['Quiet.', 'Loud.'], maxWords: 50 };

describe('createClaudeSellerAi', () => {
  it('sends the model, effort low, max_tokens, the fallbacks beta and field, and the static system prompt', async () => {
    const { client, captured } = fakeClient({
      status: 200,
      body: messageBody([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'A short summary.' }]),
    });
    const ai = createClaudeSellerAi(client, 'claude-opus-5-5');
    expect(await ai.summarizeReviews({ ...reviewInput, focus: 'noise <b>' })).toBe('A short summary.');
    expect(await ai.summarizeReviews(reviewInput)).toBe('A short summary.');
    const [withFocus, withoutFocus] = captured;
    expect(withFocus?.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: REVIEWS_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            'Summarize in at most 50 words.\n<focus>noise &lt;b&gt;</focus>\n<hotel name="Inn &quot;A&quot;">\n<review>Quiet.</review>\n<review>Loud.</review>\n</hotel>',
        },
      ],
    });
    expect(withFocus?.headers['anthropic-beta']).toBe(SELLER_AI_BETAS.join(','));
    expect(withoutFocus?.body).toMatchObject({
      system: REVIEWS_SYSTEM,
      messages: [{ role: 'user', content: 'Summarize in at most 50 words.\n<hotel name="Inn &quot;A&quot;">\n<review>Quiet.</review>\n<review>Loud.</review>\n</hotel>' }],
    });
  });

  it.each([
    ['refusal', messageBody([{ type: 'text', text: 'no' }], 'refusal')],
    ['max_tokens', messageBody([{ type: 'text', text: 'cut' }], 'max_tokens')],
    ['no text block', messageBody([{ type: 'thinking', thinking: '', signature: 's' }])],
  ])('throws on %s', async (_label, body) => {
    const ai = createClaudeSellerAi(fakeClient({ status: 200, body }).client, 'claude-opus-5-5');
    await expect(ai.summarizeReviews(reviewInput)).rejects.toBeInstanceOf(SellerAiError);
  });

  it('throws a SellerAiError with the status only on a typed API error', async () => {
    const { client } = fakeClient({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'raw body detail' } } });
    const ai = createClaudeSellerAi(client, 'claude-opus-5-5');
    const err = await ai.summarizeReviews(reviewInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SellerAiError);
    expect((err as Error).message).toBe('The model request failed (HTTP 529)');
    expect((err as Error).message).not.toContain('raw body detail');
    expect((err as Error).message).not.toContain('sk-ant');
  });
});
