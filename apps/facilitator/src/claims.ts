/** Claim codes for the operator CLI (operator-cli.md §3.1): generation, normalisation, hashing. */
import { randomInt } from 'node:crypto';
import { hmacHex } from './crypto';

/** How long a claim code lives, in seconds (operator-cli.md §3.2). */
export const CLAIM_TTL_SECONDS = 900;

/** The most unused, unexpired claims one operator may hold (operator-cli.md §3.2). */
export const MAX_OPEN_CLAIMS = 5;

/** Crockford base32. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const NORMALISED = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** A fresh code, drawn uniformly (60 bits). `display` is `XXXX-XXXX-XXXX`; `normalised` is what is hashed. */
export function generateClaimCode(): { display: string; normalised: string } {
  let normalised = '';
  for (let i = 0; i < CODE_LENGTH; i++) normalised += ALPHABET[randomInt(ALPHABET.length)];
  return { display: `${normalised.slice(0, 4)}-${normalised.slice(4, 8)}-${normalised.slice(8)}`, normalised };
}

/**
 * Removes `-` and whitespace, upper-cases, and decodes `O` to `0` and `I` and `L` to `1`. Returns
 * `undefined` unless the result is exactly 12 characters of the alphabet.
 */
export function normaliseClaimCode(input: string): string | undefined {
  const normalised = input
    .replace(/[-\s]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return NORMALISED.test(normalised) ? normalised : undefined;
}

/** `HMAC-SHA256(pepper, "claim:" + normalised)` in hex: the only form in which a code is stored. */
export function claimCodeHash(pepper: string, normalised: string): string {
  return hmacHex(pepper, `claim:${normalised}`);
}
