import type { Price } from '@x402/core/types';
import { ASSET } from './constants';

/** Smallest valid amount, in cents. Zero is never valid. */
export const MIN_CENTS = 1;

/** Largest valid amount, in cents ($100,000). */
export const MAX_CENTS = 10_000_000;

const CENTS_STRING = /^[1-9][0-9]{0,7}$/;
const DOLLARS_STRING = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/** Returns true when `cents` is a safe integer within the valid amount range. */
export function isValidCents(cents: number): boolean {
  return Number.isSafeInteger(cents) && cents >= MIN_CENTS && cents <= MAX_CENTS;
}

function checkRange(cents: number, input: unknown): number {
  if (!isValidCents(cents)) {
    throw new RangeError(`Amount out of range: ${JSON.stringify(input)}`);
  }
  return cents;
}

/**
 * Parses an atomic cents string such as `"5"` or `"1234"`. No sign, decimal point or leading
 * zeros; the value must be between 1 and 10,000,000.
 */
export function parseCentsString(s: string): number {
  if (typeof s !== 'string' || !CENTS_STRING.test(s)) {
    throw new TypeError(`Invalid cents string: ${JSON.stringify(s)}`);
  }
  return checkRange(Number(s), s);
}

/** Like `parseCentsString`, but returns `undefined` instead of throwing. */
export function tryParseCentsString(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  try {
    return parseCentsString(s);
  } catch {
    return undefined;
  }
}

function dollarsStringToCents(input: string, original: unknown): number {
  const match = DOLLARS_STRING.exec(input);
  if (!match) {
    throw new TypeError(`Invalid USD price: ${JSON.stringify(original)}`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  if (whole.length > 6) {
    throw new RangeError(`Amount out of range: ${JSON.stringify(original)}`);
  }
  return checkRange(Number(whole) * 100 + Number(fraction), original);
}

/**
 * Converts an x402 price into cents.
 *
 * Accepts `"$0.05"`, `"0.05"`, the number `0.05` (dollars, at most two decimal places), or an
 * `AssetAmount` with `asset: "USD"` and a cents `amount` string. Never uses floating-point
 * arithmetic on the value.
 */
export function priceToCents(price: Price): number {
  if (typeof price === 'number') {
    if (!Number.isFinite(price)) {
      throw new TypeError(`Invalid USD price: ${String(price)}`);
    }
    // String(n) yields the shortest decimal string that round-trips, e.g. 0.05 -> "0.05".
    return dollarsStringToCents(String(price), price);
  }
  if (typeof price === 'string') {
    const trimmed = price.trim();
    return dollarsStringToCents(trimmed.startsWith('$') ? trimmed.slice(1) : trimmed, price);
  }
  if (price !== null && typeof price === 'object') {
    if (price.asset !== ASSET) {
      throw new TypeError(`Unsupported asset: ${JSON.stringify(price.asset)}`);
    }
    return parseCentsString(price.amount);
  }
  throw new TypeError(`Invalid price: ${JSON.stringify(price)}`);
}

/** Formats cents as a `"D.CC"` USD string, for example 5 -> `"0.05"`, 1234 -> `"12.34"`. */
export function centsToUsdString(cents: number): string {
  checkRange(cents, cents);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}
