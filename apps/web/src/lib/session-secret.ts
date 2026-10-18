/**
 * `npm run dev:stack`: the session secret (build spec, Milestone 11). `WEB_SESSION_SECRET` wins
 * and the file is never touched. Without it, the secret is kept in `data/web-session.key`
 * (ignored through `*.key`), so a restart keeps every session. Never prints the value.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const SESSION_KEY_FILE = 'data/web-session.key';
export const SESSION_KEY_KEPT =
  'WEB_SESSION_SECRET is not set: using the one kept in data/web-session.key, so sessions survive restarts.';
export const SESSION_KEY_MALFORMED = 'data/web-session.key is not 64 hex characters. Fix or delete it, then try again.';

const HEX_64 = /^[0-9a-fA-F]{64}$/;

export type SessionSecret = { ok: true; secret: string; message?: string } | { ok: false; message: string };

function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Resolves the secret for the web app. `file` is the absolute path of `data/web-session.key`;
 * its directory must exist. A malformed file is refused and never overwritten.
 */
export function resolveSessionSecret(envValue: string | undefined, file: string): SessionSecret {
  const fromEnv = envValue?.trim();
  if (fromEnv) return { ok: true, secret: fromEnv };
  const stored = readIfPresent(file);
  if (stored !== undefined) {
    const secret = stored.trim();
    return HEX_64.test(secret) ? { ok: true, secret, message: SESSION_KEY_KEPT } : { ok: false, message: SESSION_KEY_MALFORMED };
  }
  const secret = randomBytes(32).toString('hex');
  // Exclusive create; the mode is best effort on Windows.
  writeFileSync(file, secret, { flag: 'wx', mode: 0o600 });
  return { ok: true, secret, message: SESSION_KEY_KEPT };
}
