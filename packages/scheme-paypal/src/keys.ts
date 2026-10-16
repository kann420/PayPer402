import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { decodeBase64UrlExact, sha256Base64Url } from './encoding';

/** Raw Ed25519 key length in bytes (public key and private seed). */
export const ED25519_KEY_BYTES = 32;

/** An agent's Ed25519 key pair with its derived public identifiers. */
export interface AgentKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw 32-byte public key, base64url without padding (the JWK `x` member). */
  publicKeyX: string;
  /** base64url (no padding) SHA-256 of the raw public key. */
  kid: string;
}

/** Ed25519 private key as a JWK. */
export interface Ed25519PrivateJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d: string;
}

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function assertEd25519(key: KeyObject, type: 'private' | 'public'): void {
  if (key.type !== type || key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`Expected an Ed25519 ${type} key`);
  }
}

/** Returns the raw public key (JWK `x`) of an Ed25519 public or private key. */
export function publicKeyX(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  assertEd25519(publicKey, 'public');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new TypeError('Ed25519 public key has no x member');
  return jwk.x;
}

/** Derives the key id from a raw public key (`x`). Throws if `x` is not 32 bytes of base64url. */
export function kidFromPublicKeyX(x: string): string {
  const raw = decodeBase64UrlExact(x, ED25519_KEY_BYTES);
  if (!raw) throw new TypeError('publicKeyX must be 32 bytes, base64url without padding');
  return sha256Base64Url(raw);
}

/** Imports a raw public key (`x`) as a KeyObject. Throws on invalid input. */
export function publicKeyFromX(x: string): KeyObject {
  if (!decodeBase64UrlExact(x, ED25519_KEY_BYTES)) {
    throw new TypeError('publicKeyX must be 32 bytes, base64url without padding');
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/** Builds the full `AgentKey` for an Ed25519 private key. */
export function agentKeyFromPrivateKey(privateKey: KeyObject): AgentKey {
  assertEd25519(privateKey, 'private');
  const publicKey = createPublicKey(privateKey);
  const x = publicKeyX(publicKey);
  return { privateKey, publicKey, publicKeyX: x, kid: kidFromPublicKeyX(x) };
}

/** Generates a new agent key. */
export function generateAgentKey(): AgentKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return agentKeyFromPrivateKey(privateKey);
}

/** Exports a private key as a JWK (`kty`, `crv`, `x`, `d`). Treat the result as a secret. */
export function exportPrivateKeyJwk(privateKey: KeyObject): Ed25519PrivateJwk {
  assertEd25519(privateKey, 'private');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') {
    throw new TypeError('Ed25519 private key JWK is incomplete');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d };
}

/** Imports a private key JWK. Throws if it is not a consistent Ed25519 key. */
export function importPrivateKeyJwk(jwk: Ed25519PrivateJwk): KeyObject {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new TypeError('Not an Ed25519 JWK');
  const privateKey = importPrivateKeyRaw(jwk.d);
  if (publicKeyX(privateKey) !== jwk.x) throw new TypeError('JWK x does not match d');
  return privateKey;
}

/** Exports the raw 32-byte private seed (JWK `d`) as base64url. Treat the result as a secret. */
export function exportPrivateKeyRaw(privateKey: KeyObject): string {
  return exportPrivateKeyJwk(privateKey).d;
}

/** Imports a raw 32-byte private seed given as base64url. Throws on invalid input. */
export function importPrivateKeyRaw(d: string): KeyObject {
  const seed = decodeBase64UrlExact(d, ED25519_KEY_BYTES);
  if (!seed) throw new TypeError('Private key must be 32 bytes, base64url without padding');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}
