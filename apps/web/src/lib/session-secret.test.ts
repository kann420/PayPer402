import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_KEY_KEPT, SESSION_KEY_MALFORMED, resolveSessionSecret } from './session-secret';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pp402-session-'));
  file = path.join(dir, 'web-session.key');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('dev:stack session secret', () => {
  it('uses WEB_SESSION_SECRET when set and never touches the file', () => {
    writeFileSync(file, 'not hex at all');
    const before = statSync(file).mtimeMs;
    const fromEnv = 'cd'.repeat(32);
    expect(resolveSessionSecret(`  ${fromEnv} `, file)).toEqual({ ok: true, secret: fromEnv });
    expect(readFileSync(file, 'utf8')).toBe('not hex at all');
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('treats an empty or blank WEB_SESSION_SECRET as unset', () => {
    for (const blank of ['', '   ']) {
      const result = resolveSessionSecret(blank, file);
      expect(result).toMatchObject({ ok: true, message: SESSION_KEY_KEPT });
    }
  });

  it('reuses a kept file of 64 hex characters (trimmed)', () => {
    const kept = 'AbCd'.repeat(16);
    writeFileSync(file, `\n${kept}\r\n`);
    expect(resolveSessionSecret(undefined, file)).toEqual({ ok: true, secret: kept, message: SESSION_KEY_KEPT });
    expect(readFileSync(file, 'utf8')).toBe(`\n${kept}\r\n`);
  });

  it('creates the file with 32 random bytes in hex when it is missing, and reuses it on the next start', () => {
    const first = resolveSessionSecret(undefined, file);
    expect(first).toMatchObject({ ok: true, message: SESSION_KEY_KEPT });
    const secret = first.ok ? first.secret : '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(file, 'utf8')).toBe(secret);
    expect(resolveSessionSecret(undefined, file)).toEqual({ ok: true, secret, message: SESSION_KEY_KEPT });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([['short', 'ab'.repeat(31)], ['too long', 'ab'.repeat(33)], ['not hex', 'zz'.repeat(32)], ['empty', '']])(
    'refuses a malformed file (%s) and never overwrites it',
    (_label, content) => {
      writeFileSync(file, content);
      const result = resolveSessionSecret(undefined, file);
      expect(result).toEqual({ ok: false, message: SESSION_KEY_MALFORMED });
      expect(readFileSync(file, 'utf8')).toBe(content);
    },
  );
});
