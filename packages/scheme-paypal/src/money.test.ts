import { describe, expect, it } from 'vitest';
import { MAX_CENTS, centsToUsdString, parseCentsString, priceToCents, tryParseCentsString } from './money';

describe('parseCentsString', () => {
  it('accepts canonical cents strings within range', () => {
    expect(parseCentsString('1')).toBe(1);
    expect(parseCentsString('5')).toBe(5);
    expect(parseCentsString('1234')).toBe(1234);
    expect(parseCentsString('10000000')).toBe(MAX_CENTS);
  });

  it.each(['0', '-1', '+1', '01', '1.5', '1e3', ' 1', '1 ', '', 'abc', '10000001', '123456789'])(
    'rejects %j',
    (input) => {
      expect(() => parseCentsString(input)).toThrow();
      expect(tryParseCentsString(input)).toBeUndefined();
    },
  );

  it('rejects non-strings without throwing in the try variant', () => {
    expect(tryParseCentsString(5)).toBeUndefined();
    expect(tryParseCentsString(undefined)).toBeUndefined();
  });
});

describe('priceToCents', () => {
  it('parses dollar strings, with or without $', () => {
    expect(priceToCents('$0.05')).toBe(5);
    expect(priceToCents('0.05')).toBe(5);
    expect(priceToCents('$1')).toBe(100);
    expect(priceToCents('$1.5')).toBe(150);
    expect(priceToCents('12.34')).toBe(1234);
    expect(priceToCents('$100000')).toBe(MAX_CENTS);
  });

  it('parses dollar numbers without floating-point drift', () => {
    expect(priceToCents(0.05)).toBe(5);
    expect(priceToCents(0.1)).toBe(10);
    expect(priceToCents(0.29)).toBe(29);
    expect(priceToCents(1.15)).toBe(115);
    expect(priceToCents(19.99)).toBe(1999);
    expect(priceToCents(2)).toBe(200);
  });

  it('rejects a computed float such as 0.1 + 0.2', () => {
    expect(() => priceToCents(0.1 + 0.2)).toThrow();
  });

  it('parses a USD AssetAmount in cents', () => {
    expect(priceToCents({ asset: 'USD', amount: '7' })).toBe(7);
  });

  it.each([
    ['more than two decimals', '$0.051'],
    ['negative', '-0.05'],
    ['negative with $', '$-0.05'],
    ['zero', '$0'],
    ['zero cents', '0.00'],
    ['empty', ''],
    ['garbage', 'five cents'],
    ['above the maximum', '$100000.01'],
    ['leading zero', '007'],
  ])('rejects %s', (_label, input) => {
    expect(() => priceToCents(input)).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.05, 0, 0.001, 1e-7, 1e21])('rejects the number %s', (input) => {
    expect(() => priceToCents(input)).toThrow();
  });

  it('rejects other assets and non-cents amounts', () => {
    expect(() => priceToCents({ asset: 'EUR', amount: '5' })).toThrow();
    expect(() => priceToCents({ asset: 'USD', amount: '0.05' })).toThrow();
    expect(() => priceToCents({ asset: 'USD', amount: '0' })).toThrow();
  });
});

describe('centsToUsdString', () => {
  it('formats D.CC', () => {
    expect(centsToUsdString(1)).toBe('0.01');
    expect(centsToUsdString(5)).toBe('0.05');
    expect(centsToUsdString(10)).toBe('0.10');
    expect(centsToUsdString(100)).toBe('1.00');
    expect(centsToUsdString(1234)).toBe('12.34');
    expect(centsToUsdString(MAX_CENTS)).toBe('100000.00');
  });

  it('rejects values out of range', () => {
    expect(() => centsToUsdString(0)).toThrow();
    expect(() => centsToUsdString(1.5)).toThrow();
    expect(() => centsToUsdString(MAX_CENTS + 1)).toThrow();
  });
});
