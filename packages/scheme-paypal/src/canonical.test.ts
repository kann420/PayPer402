import { describe, expect, it } from 'vitest';
import { canonical, type CanonicalObject } from './canonical';

describe('canonical', () => {
  it('matches a pinned vector: sorted keys, nested objects, no whitespace', () => {
    const value = { b: '2', a: 1, c: { z: 'x', y: 0 }, A: 'q', 'é': 'u' };
    expect(canonical(value)).toBe('{"A":"q","a":1,"b":"2","c":{"y":0,"z":"x"},"é":"u"}');
  });

  it('sorts by UTF-16 code unit, not by code point', () => {
    // U+1F600 is encoded as the surrogate pair D83D DE00, which sorts before U+FB01.
    const value = { 'ﬁ': 'ligature', '\u{1f600}': 'emoji' };
    expect(canonical(value)).toBe('{"\u{1f600}":"emoji","ﬁ":"ligature"}');
  });

  it('escapes strings as JSON.stringify does', () => {
    expect(canonical({ s: 'line\nquote"back\\' })).toBe('{"s":"line\\nquote\\"back\\\\"}');
  });

  it('pins the bytes of a commitment', () => {
    const commitment = {
      v: 1,
      id: 'q3V9mJr0Tn6w8dYk2bXo4A',
      kid: 'Wc1t0rAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      network: 'paypal:sandbox',
      asset: 'USD',
      payTo: 'seller_7Qm2',
      maxAmount: '5',
      iat: 1760500000,
      exp: 1760500120,
    };
    expect(canonical(commitment)).toBe(
      '{"asset":"USD","exp":1760500120,"iat":1760500000,"id":"q3V9mJr0Tn6w8dYk2bXo4A",' +
        '"kid":"Wc1t0rAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","maxAmount":"5","network":"paypal:sandbox",' +
        '"payTo":"seller_7Qm2","v":1}',
    );
  });

  it.each([
    ['a float', { n: 1.5 }],
    ['an unsafe integer', { n: 2 ** 53 }],
    ['NaN', { n: Number.NaN }],
    ['a boolean', { b: true }],
    ['null', { n: null }],
    ['an array', { a: ['x'] }],
    ['a date', { d: new Date(0) }],
    ['undefined', { u: undefined }],
  ])('throws on %s', (_label, value) => {
    expect(() => canonical(value as unknown as CanonicalObject)).toThrow(TypeError);
  });

  it('throws when the top level is not a plain object', () => {
    expect(() => canonical([] as unknown as CanonicalObject)).toThrow(TypeError);
  });
});
