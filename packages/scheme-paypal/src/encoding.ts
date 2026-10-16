import { createHash } from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Encodes bytes as base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Decodes a base64url string (no padding) that must hold exactly `byteLength` bytes.
 *
 * `Buffer.from(s, "base64url")` never throws and silently skips invalid characters, so this also
 * requires the exact encoded length and a lossless round trip. Returns `undefined` on any mismatch.
 */
export function decodeBase64UrlExact(s: unknown, byteLength: number): Buffer | undefined {
  if (typeof s !== 'string') return undefined;
  if (s.length !== Math.ceil((byteLength * 4) / 3) || !BASE64URL.test(s)) return undefined;
  const bytes = Buffer.from(s, 'base64url');
  if (bytes.length !== byteLength || bytes.toString('base64url') !== s) return undefined;
  return bytes;
}

/** SHA-256 of `data`, as base64url without padding. */
export function sha256Base64Url(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('base64url');
}
