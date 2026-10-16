import type { RequestHandler, Response } from 'express';
import { hmacHex, randomId, randomToken } from './crypto';
import type { Db } from './db/connection';
import { HttpError } from './http';

export type Role = 'operator' | 'seller';

export interface AuthContext {
  role: Role;
  ownerId: string;
  keyId: string;
}

const PREFIX: Record<Role, string> = { operator: 'pp402_op_', seller: 'pp402_sel_' };
const KEY_FORMAT = /^pp402_(op|sel)_[A-Za-z0-9_-]{43}$/;

/** A new API key: `pp402_op_` or `pp402_sel_` plus 32 random bytes in base64url (43 chars). */
export function generateApiKey(role: Role): string {
  return `${PREFIX[role]}${randomToken(32)}`;
}

/** `HMAC-SHA256(API_KEY_PEPPER, key)` in hex: the only form in which keys are stored. */
export function hashApiKey(pepper: string, key: string): string {
  return hmacHex(pepper, key);
}

/** Creates and stores a key for an owner. Returns the plaintext key, to be shown once. */
export function issueApiKey(db: Db, pepper: string, role: Role, ownerId: string, label: string, now: number): string {
  const key = generateApiKey(role);
  db.prepare(
    `INSERT INTO api_keys (id, owner_type, owner_id, key_hash, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomId('key'), role, ownerId, hashApiKey(pepper, key), label, now);
  return key;
}

/** The authenticated caller of this request. Only valid behind `authenticate`. */
export function authOf(res: Response): AuthContext {
  const auth = res.locals['auth'] as AuthContext | undefined;
  if (!auth) throw new HttpError(401, 'unauthorized', 'Missing or invalid API key');
  return auth;
}

/**
 * Bearer API key middleware (design spec §4). A missing or unknown key gets 401; a key of a role
 * not in `roles` gets 403.
 */
export function authenticate(db: Db, pepper: string, clock: () => number, roles: readonly Role[]): RequestHandler {
  const lookup = db.prepare(
    `SELECT id, owner_type AS role, owner_id AS ownerId FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
  );
  const touch = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    const key = match?.[1];
    if (!key || !KEY_FORMAT.test(key)) {
      next(new HttpError(401, 'unauthorized', 'Missing or invalid API key'));
      return;
    }
    const row = lookup.get(hashApiKey(pepper, key)) as { id: string; role: Role; ownerId: string } | undefined;
    if (!row) {
      next(new HttpError(401, 'unauthorized', 'Missing or invalid API key'));
      return;
    }
    if (!roles.includes(row.role)) {
      next(new HttpError(403, 'forbidden', 'This API key cannot use this endpoint'));
      return;
    }
    touch.run(clock(), row.id);
    const auth: AuthContext = { role: row.role, ownerId: row.ownerId, keyId: row.id };
    res.locals['auth'] = auth;
    next();
  };
}
