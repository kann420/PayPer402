import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCommitment,
  commitmentMessage,
  newCommitmentId,
  parsePayload,
  payloadHash,
  signCommitment,
  verifyCommitmentSignature,
  type Commitment,
} from './commitment';
import { generateAgentKey, importPrivateKeyRaw, agentKeyFromPrivateKey } from './keys';

const RFC8032_SECRET = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';

function sample(kid: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    ...buildCommitment({
      id: 'q3V9mJr0Tn6w8dYk2bXo4A',
      kid,
      network: 'paypal:sandbox',
      asset: 'USD',
      payTo: 'seller_7Qm2',
      maxAmount: '5',
      iat: 1760500000,
      exp: 1760500120,
    }),
    ...overrides,
  };
}

describe('commitment ids', () => {
  it('are 16 random bytes as 22 base64url characters', () => {
    const id = newCommitmentId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(id, 'base64url')).toHaveLength(16);
    expect(newCommitmentId()).not.toBe(id);
  });
});

describe('commitment signatures', () => {
  const key = agentKeyFromPrivateKey(importPrivateKeyRaw(Buffer.from(RFC8032_SECRET, 'hex').toString('base64url')));

  it('signs the domain-prefixed canonical commitment', () => {
    const commitment = sample(key.kid);
    expect(commitmentMessage(commitment)).toBe(
      'payper402/commitment/v1\n' +
        `{"asset":"USD","exp":1760500120,"iat":1760500000,"id":"q3V9mJr0Tn6w8dYk2bXo4A","kid":"${key.kid}",` +
        '"maxAmount":"5","network":"paypal:sandbox","payTo":"seller_7Qm2","v":1}',
    );
    const signature = signCommitment(commitment, key.privateKey);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // Ed25519 is deterministic: the same key and commitment always give the same signature.
    expect(signCommitment(commitment, key.privateKey)).toBe(signature);
    expect(verifyCommitmentSignature(commitment, signature, key.publicKeyX)).toBe(true);
    expect(verifyCommitmentSignature(commitment, signature, key.publicKey)).toBe(true);
  });

  it('does not verify a changed commitment or another key', () => {
    const commitment = sample(key.kid);
    const signature = signCommitment(commitment, key.privateKey);
    expect(verifyCommitmentSignature({ ...commitment, maxAmount: '6' }, signature, key.publicKeyX)).toBe(false);
    expect(verifyCommitmentSignature(commitment, signature, generateAgentKey().publicKeyX)).toBe(false);
  });

  it('returns false instead of throwing on bad input', () => {
    const commitment = sample(key.kid);
    expect(verifyCommitmentSignature(commitment, '', key.publicKeyX)).toBe(false);
    expect(verifyCommitmentSignature(commitment, '!'.repeat(86), key.publicKeyX)).toBe(false);
    expect(verifyCommitmentSignature(commitment, randomBytes(63).toString('base64url'), key.publicKeyX)).toBe(false);
    expect(verifyCommitmentSignature(commitment, randomBytes(64).toString('base64url'), 'not-a-key')).toBe(false);
    expect(verifyCommitmentSignature(commitment, randomBytes(64).toString('base64url'), key.privateKey)).toBe(false);
  });
});

describe('payloadHash', () => {
  it('depends on the commitment and the signature only', () => {
    const key = generateAgentKey();
    const commitment = sample(key.kid);
    const signature = signCommitment(commitment, key.privateKey);
    const hash = payloadHash(commitment, signature);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payloadHash({ ...commitment }, signature)).toBe(hash);
    expect(payloadHash({ ...commitment, iat: commitment.iat + 1 }, signature)).not.toBe(hash);
    expect(payloadHash(commitment, signCommitment(sample(key.kid, { exp: 1760500100 }), key.privateKey))).not.toBe(
      hash,
    );
  });
});

describe('parsePayload', () => {
  const key = generateAgentKey();
  const commitment = sample(key.kid);
  const signature = signCommitment(commitment, key.privateKey);

  it('accepts a well-formed payload', () => {
    expect(parsePayload({ commitment, signature })).toEqual({ ok: true, payload: { commitment, signature } });
  });

  it.each([
    ['a missing commitment', { signature }],
    ['a missing signature', { commitment }],
    ['an unknown commitment field', { commitment: { ...commitment, aud: 'x' }, signature }],
    ['v = 2', { commitment: { ...commitment, v: 2 }, signature }],
    ['a short id', { commitment: { ...commitment, id: 'abc' }, signature }],
    ['a padded id', { commitment: { ...commitment, id: `${commitment.id}==` }, signature }],
    ['a kid with invalid characters', { commitment: { ...commitment, kid: '+'.repeat(43) }, signature }],
    ['a numeric maxAmount', { commitment: { ...commitment, maxAmount: 5 }, signature }],
    ['maxAmount "0"', { commitment: { ...commitment, maxAmount: '0' }, signature }],
    ['maxAmount "05"', { commitment: { ...commitment, maxAmount: '05' }, signature }],
    ['a fractional iat', { commitment: { ...commitment, iat: 1.5 }, signature }],
    ['a string exp', { commitment: { ...commitment, exp: '1760500120' }, signature }],
    ['an empty payTo', { commitment: { ...commitment, payTo: '' }, signature }],
    ['garbage base64 signature', { commitment, signature: '%%%' }],
    ['a 63-byte signature', { commitment, signature: randomBytes(63).toString('base64url') }],
    ['a non-object', 'payload'],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(parsePayload(input).ok).toBe(false);
  });
});
