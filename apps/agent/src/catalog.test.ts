import { describe, expect, it } from 'vitest';
import { catalog as demoCatalog } from '@payper402/demo-seller';
import { CatalogError, parseCatalog, serviceUrl, validateParams, type CatalogService } from './catalog';

const valid = () => structuredClone(demoCatalog({ name: 'Acme Data', payTo: 'sel_demo' })) as unknown as Record<string, unknown> & {
  services: Record<string, unknown>[];
  seller: Record<string, unknown>;
};

const WALK = { hotelId: 'gion-lantern-house', place: 'kiyomizu-dera' };

function service(id: string): CatalogService {
  const found = parseCatalog(valid()).services.find((s) => s.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

describe('catalog schema', () => {
  it('accepts the real demo seller catalog', () => {
    const parsed = parseCatalog(valid());
    expect(parsed.services.map((s) => s.id)).toEqual(['hotel_search', 'hotel_rates', 'review_summary', 'walking_time', 'price_forecast']);
    expect(parsed.seller).toEqual({ name: 'Acme Data', payTo: 'sel_demo' });
  });

  const cases: [string, (c: ReturnType<typeof valid>) => void][] = [
    ['an unknown top-level field', (c) => Object.assign(c, { extra: 1 })],
    ['an unknown service field', (c) => Object.assign(c.services[0] ?? {}, { url: 'https://evil.example' })],
    ['a bad id', (c) => Object.assign(c.services[0] ?? {}, { id: 'Hotel-1' })],
    ['a duplicate id', (c) => Object.assign(c.services[1] ?? {}, { id: 'hotel_search' })],
    ['a long description', (c) => Object.assign(c.services[0] ?? {}, { description: 'x'.repeat(301) })],
    ['a path with //', (c) => Object.assign(c.services[0] ?? {}, { path: '//evil.example/x' })],
    ['a path with ..', (c) => Object.assign(c.services[0] ?? {}, { path: '/v1/../admin' })],
    ['an absolute URL path', (c) => Object.assign(c.services[0] ?? {}, { path: 'https://evil.example/v1' })],
    ['the wrong network', (c) => Object.assign(c, { network: 'eip155:8453' })],
    ['the wrong scheme', (c) => Object.assign(c, { scheme: 'exact' })],
    ['the wrong asset', (c) => Object.assign(c, { asset: 'EUR' })],
    ['too many params', (c) => {
      const params: Record<string, unknown> = {};
      for (let i = 0; i < 9; i += 1) params[`p${i}`] = { type: 'string', description: 'x' };
      Object.assign(c.services[0] ?? {}, { params, required: [] });
    }],
    ['a bad param name', (c) => Object.assign(c.services[0] ?? {}, { params: { '1bad': { type: 'string', description: 'x' } }, required: [] })],
    ['a string maxLength over 8000', (c) => Object.assign(c.services[2] ?? {}, {
      params: { focus: { type: 'string', description: 'x', maxLength: 8001 } },
      required: ['focus'],
    })],
    ['an invalid price', (c) => Object.assign(c.services[0] ?? {}, { priceCents: 0 })],
    ['a fractional price', (c) => Object.assign(c.services[0] ?? {}, { priceCents: 2.5 })],
    ['a long seller name', (c) => Object.assign(c.seller, { name: 'x'.repeat(61) })],
    ['an empty payTo', (c) => Object.assign(c.seller, { payTo: '' })],
    ['a required param that is not listed', (c) => Object.assign(c.services[0] ?? {}, { required: ['city', 'other'] })],
    ['a required prototype key', (c) => Object.assign(c.services[0] ?? {}, { required: ['city', 'constructor'] })],
    ['too many services', (c) => {
      c.services = Array.from({ length: 21 }, (_, i) => ({ ...c.services[0], id: `s${i}` }));
    }],
  ];

  it.each(cases)('rejects %s', (_label, mutate) => {
    const c = valid();
    mutate(c);
    expect(() => parseCatalog(c)).toThrow(CatalogError);
  });

  it('builds service URLs on the seller origin only', () => {
    expect(serviceUrl('http://127.0.0.1:4021', service('hotel_rates')).href).toBe('http://127.0.0.1:4021/v1/hotels/rates');
    expect(() => serviceUrl('http://127.0.0.1:4021', { ...service('hotel_rates'), path: '//evil.example/x' })).toThrow(CatalogError);
  });
});

describe('params validation', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('rejects the prototype key %s as an unknown param', (name) => {
    // JSON.parse makes `__proto__` an own key, as a tool input would.
    const params = JSON.parse(`{"hotelId":"gion-lantern-house","place":"kiyomizu-dera","${name}":"x"}`) as Record<string, unknown>;
    expect(validateParams(service('walking_time'), params)).toEqual([{ param: name, message: 'unknown param' }]);
  });

  it('never reads a declared param through the prototype', () => {
    const constructorService: CatalogService = {
      ...service('walking_time'),
      params: { constructor: { type: 'string' as const, description: 'x' } },
      required: ['constructor'],
    };
    expect(validateParams(constructorService, {})).toEqual([{ param: 'constructor', message: 'required' }]);
    expect(validateParams(constructorService, { constructor: 'x' })).toEqual([]);
  });

  it('accepts valid params', () => {
    expect(validateParams(service('walking_time'), WALK)).toEqual([]);
    expect(validateParams(service('hotel_search'), { city: 'kyoto', checkIn: '2027-03-30', checkOut: '2027-04-02', maxPricePerNight: 250 })).toEqual([]);
  });

  const SEARCH = { city: 'kyoto', checkIn: '2027-03-30', checkOut: '2027-04-02' };

  it.each([
    ['an unknown param', 'walking_time', { ...WALK, extra: 'x' }, 'extra', 'unknown param'],
    ['a missing param', 'walking_time', { hotelId: WALK.hotelId }, 'place', 'required'],
    ['a wrong type (string)', 'walking_time', { ...WALK, place: 5 }, 'place', 'must be a string'],
    ['a wrong type (integer)', 'hotel_search', { ...SEARCH, maxPricePerNight: '250' }, 'maxPricePerNight', 'must be an integer'],
    ['a fractional integer', 'hotel_search', { ...SEARCH, maxPricePerNight: 250.5 }, 'maxPricePerNight', 'must be an integer'],
    ['an enum miss', 'walking_time', { ...WALK, place: 'tokyo-tower' }, 'place', 'must be one of kiyomizu-dera, yasaka-shrine, gion-shijo-station, fushimi-inari, kyoto-station'],
    ['maxLength', 'review_summary', { hotelId: WALK.hotelId, focus: 'a'.repeat(81) }, 'focus', 'must be at most 80 characters'],
    ['an integer below the minimum', 'hotel_search', { ...SEARCH, maxPricePerNight: 19 }, 'maxPricePerNight', 'must be at least 20'],
    ['an integer above the maximum', 'hotel_search', { ...SEARCH, maxPricePerNight: 2001 }, 'maxPricePerNight', 'must be at most 2000'],
  ] as const)('rejects %s', (_label, id, params, param, message) => {
    expect(validateParams(service(id), params)).toContainEqual({ param, message });
  });
});
