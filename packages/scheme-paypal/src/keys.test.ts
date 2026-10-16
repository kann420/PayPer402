import { createHash, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  agentKeyFromPrivateKey,
  exportPrivateKeyJwk,
  exportPrivateKeyRaw,
  generateAgentKey,
  importPrivateKeyJwk,
  importPrivateKeyRaw,
  kidFromPublicKeyX,
  publicKeyFromX,
} from './keys';

// RFC 8032, section 7.1, test 1.
const RFC8032_SECRET = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const RFC8032_PUBLIC = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
const RFC8032_EMPTY_SIGNATURE =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

describe('agent keys', () => {
  it('imports a raw seed and derives the RFC 8032 public key', () => {
    const key = agentKeyFromPrivateKey(importPrivateKeyRaw(RFC8032_SECRET.toString('base64url')));
    expect(key.publicKeyX).toBe(RFC8032_PUBLIC.toString('base64url'));
    expect(sign(null, Buffer.alloc(0), key.privateKey).toString('hex')).toBe(RFC8032_EMPTY_SIGNATURE);
  });

  it('derives kid as base64url SHA-256 of the raw public key', () => {
    const expected = createHash('sha256').update(RFC8032_PUBLIC).digest('base64url');
    expect(kidFromPublicKeyX(RFC8032_PUBLIC.toString('base64url'))).toBe(expected);
    expect(expected).toHaveLength(43);
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates keys whose kid and publicKeyX are consistent', () => {
    const key = generateAgentKey();
    expect(key.publicKeyX).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.kid).toBe(kidFromPublicKeyX(key.publicKeyX));
    expect(generateAgentKey().kid).not.toBe(key.kid);
  });

  it('round-trips a private key through JWK', () => {
    const key = generateAgentKey();
    const jwk = exportPrivateKeyJwk(key.privateKey);
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', x: key.publicKeyX });
    const restored = agentKeyFromPrivateKey(importPrivateKeyJwk(jwk));
    expect(restored.kid).toBe(key.kid);
    const message = Buffer.from('hello');
    expect(verify(null, message, key.publicKey, sign(null, message, restored.privateKey))).toBe(true);
  });

  it('round-trips a private key through raw base64url', () => {
    const key = generateAgentKey();
    const restored = agentKeyFromPrivateKey(importPrivateKeyRaw(exportPrivateKeyRaw(key.privateKey)));
    expect(restored.publicKeyX).toBe(key.publicKeyX);
  });

  it('imports a public key from x', () => {
    const key = generateAgentKey();
    const message = Buffer.from('hello');
    expect(verify(null, message, publicKeyFromX(key.publicKeyX), sign(null, message, key.privateKey))).toBe(true);
  });

  it('rejects malformed keys', () => {
    const key = generateAgentKey();
    const jwk = exportPrivateKeyJwk(key.privateKey);
    expect(() => importPrivateKeyJwk({ ...jwk, x: generateAgentKey().publicKeyX })).toThrow();
    expect(() => importPrivateKeyRaw('too-short')).toThrow();
    expect(() => publicKeyFromX(`${key.publicKeyX}A`)).toThrow();
    expect(() => kidFromPublicKeyX('!'.repeat(43))).toThrow();
    expect(() => agentKeyFromPrivateKey(key.publicKey)).toThrow();
  });
});
