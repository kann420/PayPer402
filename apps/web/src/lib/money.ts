/**
 * Display formatting for money (design spec §8.2). Code keeps integer cents; this is the only
 * formatter. Unlike the scheme's `centsToUsdString`, it accepts 0 and negative values.
 */
export const MINUS = '−';

export function formatUsd(cents: number): string {
  const value = Math.round(cents);
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const fraction = String(abs % 100).padStart(2, '0');
  return `${value < 0 ? MINUS : ''}$${whole}.${fraction}`;
}

/** Cents to a plain dollar string for inputs: 150 → "1.50". */
export function centsToDollars(cents: number): string {
  return `${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

/** Cents to USD for AG Studio rows (two decimals, exact for whole cents). */
export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}
