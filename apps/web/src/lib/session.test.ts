import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createCipheriv, randomBytes } from 'node:crypto';
import { MAX_AGENT_KEYS, SESSION_COOKIE, newSession, readSession, seal, sessionCookie, unseal, withAgentKey, type Session } from './session';

const key = Buffer.alloc(32, 7);
const seed = (n: number) => `${String(n).padStart(2, '0')}${'A'.repeat(41)}`;

describe('session cookie', () => {
  it('round-trips a sealed session', () => {
    const session: Session = { ...newSession(), operator: { id: 'op_1', key: 'pp402_op_x', createdAt: 1 }, agents: [{ id: 'agt_1', name: 'a', seed: seed(1) }] };
    const sealed = seal(session, key);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(unseal(sealed, key)).toEqual(session);
  });

  it('treats a tampered cookie, a wrong key and an unknown v as no session', () => {
    const sealed = seal(newSession(), key);
    const parts = sealed.split('.');
    const last = parts[3] as string;
    const tampered = [...parts.slice(0, 3), `${last.slice(0, -2)}${last.endsWith('AA') ? 'BB' : 'AA'}`].join('.');
    expect(unseal(tampered, key)).toBeUndefined();
    expect(unseal(sealed, Buffer.alloc(32, 8))).toBeUndefined();
    expect(unseal('garbage', key)).toBeUndefined();
    // A correctly sealed payload with v: 2.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update(JSON.stringify({ ...newSession(), v: 2 }), 'utf8'), cipher.final()]);
    const v2 = `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
    expect(unseal(v2, key)).toBeUndefined();
  });

  it('sets HttpOnly, Path=/, SameSite=Lax, 30 days, and Secure only on https', () => {
    const plain = sessionCookie(newSession(), key, false);
    expect(plain).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('Path=/');
    expect(plain).toContain('SameSite=Lax');
    expect(plain).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(plain).not.toContain('Secure');
    expect(sessionCookie(newSession(), key, true)).toContain('Secure');
  });

  it('reads the session of a request', () => {
    const session = newSession();
    const request = new Request('http://localhost:3000/', { headers: { cookie: `other=1; ${SESSION_COOKIE}=${seal(session, key)}` } });
    expect(readSession(request, key)).toEqual(session);
    expect(readSession(new Request('http://localhost:3000/'), key)).toBeUndefined();
  });

  it('gives a new session a fresh sid', () => {
    expect(newSession().sid).not.toBe(newSession().sid);
    expect(newSession().sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('keeps at most five agent keys, dropping the oldest', () => {
    let session = newSession();
    for (let i = 1; i <= MAX_AGENT_KEYS + 1; i++) session = withAgentKey(session, { id: `agt_${i}`, name: `a${i}`, seed: seed(i) });
    expect(session.agents.map((a) => a.id)).toEqual(['agt_2', 'agt_3', 'agt_4', 'agt_5', 'agt_6']);
    expect(unseal(seal(session, key), key)).toEqual(session);
  });
});
