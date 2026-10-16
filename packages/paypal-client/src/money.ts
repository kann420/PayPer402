/**
 * Money conversion between integer cents (used everywhere in PayPer402) and PayPal's
 * `"D.CC"` decimal strings (used only on the wire).
 */

const USD_STRING = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/** Formats a non-negative safe integer of cents as `"D.CC"`, for example 5 -> `"0.05"`. */
export function centsToUsdString(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Cents must be a non-negative safe integer: ${String(cents)}`);
  }
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * Parses a PayPal amount string such as `"12.34"`, `"0.5"` or `"7"` into cents. Strict: no sign,
 * no exponent, no leading zeros, at most two decimals. Never uses floating-point arithmetic.
 */
export function usdStringToCents(value: string): number {
  if (typeof value !== 'string') throw new TypeError('USD amount must be a string');
  const match = USD_STRING.exec(value);
  if (!match) throw new TypeError(`Invalid USD amount: ${JSON.stringify(value)}`);
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) throw new RangeError(`USD amount out of range: ${value}`);
  return cents;
}
