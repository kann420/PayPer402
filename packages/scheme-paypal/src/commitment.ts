import { randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './canonical';
import { COMMITMENT_VERSION, SIGNATURE_DOMAIN } from './constants';
import { decodeBase64UrlExact, sha256Base64Url, toBase64Url } from './encoding';
import { ED25519_KEY_BYTES, publicKeyFromX } from './keys';
import { tryParseCentsString } from './money';

/** Commitment id length in bytes. */
export const COMMITMENT_ID_BYTES = 16;

/** Ed25519 signature length in bytes. */
export const SIGNATURE_BYTES = 64;

/** A signed promise to pay at most `maxAmount` cents to `payTo`. See the binding spec. */
export interface Commitment {
  v: 1;
  id: string;
  kid: string;
  network: string;
  asset: string;
  payTo: string;
  /** Cents, as a base-10 string. */
  maxAmount: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

/** The scheme-specific `PaymentPayload.payload` of this binding. */
export interface PayPalBatchPayload {
  commitment: Commitment;
  /** Ed25519 signature, base64url without padding. */
  signature: string;
}

const base64UrlBytes = (bytes: number) =>
  z.string().refine((s) => decodeBase64UrlExact(s, bytes) !== undefined, {
    message: `must be ${bytes} bytes, base64url without padding`,
  });

const unixSeconds = z.number().int().nonnegative().refine(Number.isSafeInteger, 'must be a safe integer');

/** Strict schema: unknown fields are rejected, not stripped. */
export const commitmentSchema = z
  .object({
    v: z.literal(COMMITMENT_VERSION),
    id: base64UrlBytes(COMMITMENT_ID_BYTES),
    kid: base64UrlBytes(ED25519_KEY_BYTES),
    network: z.string().min(1).max(128),
    asset: z.string().min(1).max(32),
    payTo: z.string().min(1).max(256),
    maxAmount: z.string().refine((s) => tryParseCentsString(s) !== undefined, 'must be a valid cents string'),
    iat: unixSeconds,
    exp: unixSeconds,
  })
  .strict();

export const payloadSchema = z.object({
  commitment: commitmentSchema,
  signature: base64UrlBytes(SIGNATURE_BYTES),
});

export type ParsePayloadResult =
  | { ok: true; payload: PayPalBatchPayload }
  | { ok: false; message: string };

/** Validates an untrusted `PaymentPayload.payload`. Never throws. */
export function parsePayload(payload: unknown): ParsePayloadResult {
  const result = payloadSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'payload';
    return { ok: false, message: `${where}: ${issue?.message ?? 'invalid'}` };
  }
  return { ok: true, payload: result.data };
}

/** Generates a fresh commitment id: 16 random bytes, base64url without padding. */
export function newCommitmentId(): string {
  return toBase64Url(randomBytes(COMMITMENT_ID_BYTES));
}

function toCanonicalObject(commitment: Commitment): Record<string, string | number> {
  return {
    v: commitment.v,
    id: commitment.id,
    kid: commitment.kid,
    network: commitment.network,
    asset: commitment.asset,
    payTo: commitment.payTo,
    maxAmount: commitment.maxAmount,
    iat: commitment.iat,
    exp: commitment.exp,
  };
}

/** Canonical JSON of a commitment. */
export function canonicalCommitment(commitment: Commitment): string {
  return canonical(toCanonicalObject(commitment));
}

/** The exact message an agent signs: the domain prefix followed by the canonical commitment. */
export function commitmentMessage(commitment: Commitment): string {
  return SIGNATURE_DOMAIN + canonicalCommitment(commitment);
}

/** Signs a commitment with the agent's Ed25519 private key. Returns base64url without padding. */
export function signCommitment(commitment: Commitment, privateKey: KeyObject): string {
  return toBase64Url(sign(null, Buffer.from(commitmentMessage(commitment), 'utf8'), privateKey));
}

/**
 * Verifies a commitment signature against a public key (KeyObject or raw base64url `x`).
 * Returns false, and never throws, on bad input of any kind.
 */
export function verifyCommitmentSignature(
  commitment: Commitment,
  signature: string,
  publicKey: KeyObject | string,
): boolean {
  try {
    const sig = decodeBase64UrlExact(signature, SIGNATURE_BYTES);
    if (!sig) return false;
    const key = typeof publicKey === 'string' ? publicKeyFromX(publicKey) : publicKey;
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(commitmentMessage(commitment), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/**
 * Hash that identifies one exact signed commitment: base64url SHA-256 of
 * `canonical(commitment) + "." + signature`. It does not include the settle amount.
 */
export function payloadHash(commitment: Commitment, signature: string): string {
  return sha256Base64Url(`${canonicalCommitment(commitment)}.${signature}`);
}

export interface BuildCommitmentInput {
  kid: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmount: string;
  iat: number;
  exp: number;
  id?: string;
}

/** Builds a commitment with a fresh id unless one is given. */
export function buildCommitment(input: BuildCommitmentInput): Commitment {
  return {
    v: COMMITMENT_VERSION,
    id: input.id ?? newCommitmentId(),
    kid: input.kid,
    network: input.network,
    asset: input.asset,
    payTo: input.payTo,
    maxAmount: input.maxAmount,
    iat: input.iat,
    exp: input.exp,
  };
}
