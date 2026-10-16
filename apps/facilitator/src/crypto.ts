import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]*)$/;
const LOOKUP_INFO = 'payper402 vault lookup';

/** HMAC-SHA256 in lowercase hex. */
export function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** `<prefix>_` plus 16 random bytes in base64url without padding (design spec §2). */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

/** Random base64url token of `bytes` bytes. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Sealed columns (design spec §5): AES-256-GCM under `DATA_ENCRYPTION_KEY`, stored as
 * `v1.<iv>.<tag>.<ciphertext>` in base64url. `lookupHash` is an HMAC under a key derived with
 * HKDF, so the lookup key is never the encryption key.
 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly lookupKey: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new RangeError('The data encryption key must be 32 bytes');
    this.key = Buffer.from(key);
    this.lookupKey = Buffer.from(hkdfSync('sha256', this.key, Buffer.alloc(0), LOOKUP_INFO, 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  /** Throws on a malformed value, a tampered value or the wrong key. */
  open(sealed: string): string {
    const match = SEALED.exec(sealed);
    if (!match) throw new Error('Malformed sealed value');
    const iv = Buffer.from(match[1] ?? '', 'base64url');
    const tag = Buffer.from(match[2] ?? '', 'base64url');
    const ciphertext = Buffer.from(match[3] ?? '', 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Sealed value failed authentication');
    }
  }

  /** `HMAC-SHA256(K_lookup, value)` in hex, used to find a wallet from a webhook's resource id. */
  lookupHash(value: string): string {
    return hmacHex(this.lookupKey, value);
  }

  /** Exposed for tests only: the derived lookup key must differ from the AES key. */
  lookupKeyForTest(): Buffer {
    return Buffer.from(this.lookupKey);
  }
}
