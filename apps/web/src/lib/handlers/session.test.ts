import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { body, createWebHarness, type WebHarness } from '../test-support';
import { requireScope, RouteError } from './common';
import { DEMO_LIMIT_MESSAGE, createSessionHandler } from './session';

let w: WebHarness;
beforeEach(async () => {
  w = await createWebHarness({ env: { WEB_LIMIT_OPERATORS_PER_HOUR: '3' } });
});
afterEach(async () => {
  await w.close();
});

const post = async (payload: unknown, init: { origin?: string | null; cookie?: string | null } = {}) =>
  w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: payload, ...init })));

const operatorCount = () => (w.h.db.prepare('SELECT COUNT(*) AS n FROM operators').get() as { n: number }).n;

describe('POST /api/session', () => {
  it('creates a demo operator and a session cookie', async () => {
    const res = await post({ role: 'operator' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ next: '/app/onboarding/link' });
    const session = w.session();
    expect(session?.operator?.id).toMatch(/^op_/);
    expect(session?.agents).toEqual([]);
    expect(res.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(operatorCount()).toBe(1);
  });

  it('reuses the operator of a valid session and keeps the sid', async () => {
    await post({ role: 'operator' });
    const first = w.session();
    w.h.activateWallet(first?.operator?.id as string);
    const res = await post({ role: 'operator' });
    expect(await body(res)).toEqual({ next: '/app' });
    expect(w.session()?.operator?.id).toBe(first?.operator?.id);
    expect(w.session()?.sid).toBe(first?.sid);
    expect(operatorCount()).toBe(1);
  });

  it('creates a new operator when the old key answers 401', async () => {
    await post({ role: 'operator' });
    const first = w.session();
    w.h.db.prepare('UPDATE api_keys SET revoked_at = 1 WHERE owner_id = ?').run(first?.operator?.id);
    const res = await post({ role: 'operator' });
    expect(res.status).toBe(200);
    expect(w.session()?.operator?.id).not.toBe(first?.operator?.id);
    expect(w.session()?.sid).toBe(first?.sid);
    expect(operatorCount()).toBe(2);
  });

  it('starts over with a new operator and no agent keys', async () => {
    await post({ role: 'operator' });
    const first = w.session();
    const res = await post({ role: 'operator', startOver: true });
    expect(await body(res)).toEqual({ next: '/app/onboarding/link' });
    expect(w.session()?.operator?.id).not.toBe(first?.operator?.id);
    expect(operatorCount()).toBe(2);
  });

  it('answers 429 demo_limit past the per-client limit', async () => {
    for (let i = 0; i < 3; i++) expect((await post({ role: 'operator', startOver: true })).status).toBe(200);
    const res = await post({ role: 'operator', startOver: true });
    expect(res.status).toBe(429);
    expect(await body(res)).toEqual({ error: 'demo_limit', message: DEMO_LIMIT_MESSAGE });
    expect(operatorCount()).toBe(3);
  });

  it('opens the seller console and keeps the operator', async () => {
    await post({ role: 'operator' });
    const before = w.session();
    const res = await post({ role: 'seller' });
    expect(await body(res)).toEqual({ next: '/seller' });
    expect(w.session()?.operator).toEqual(before?.operator);
    w.jar.value = undefined;
    const fresh = await post({ role: 'seller' });
    expect(await body(fresh)).toEqual({ next: '/seller' });
    expect(w.session()?.operator).toBeUndefined();
  });

  it('refuses a foreign origin and an invalid body', async () => {
    expect((await post({ role: 'operator' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ role: 'admin' })).status).toBe(400);
    expect((await post({ role: 'operator', extra: 1 })).status).toBe(400);
    expect(operatorCount()).toBe(0);
  });
});

describe('scope guards', () => {
  it('needs an operator for scope=operator and any valid session for scope=seller', async () => {
    const guard = (path: string) => {
      try {
        return requireScope(w.request(path), w.key).scope;
      } catch (error) {
        return error instanceof RouteError ? `${error.status} ${error.code}` : 'other';
      }
    };
    expect(guard('/api/events?scope=operator')).toBe('401 no_session');
    expect(guard('/api/ai/turn?scope=seller')).toBe('401 no_session');
    await post({ role: 'seller' });
    expect(guard('/api/events?scope=seller')).toBe('seller');
    expect(guard('/api/ai/turn?scope=operator')).toBe('401 no_session');
    await post({ role: 'operator' });
    expect(guard('/api/events?scope=operator')).toBe('operator');
    expect(guard('/api/ai/turn?scope=operator')).toBe('operator');
    expect(guard('/api/events?scope=admin')).toBe('400 validation_failed');
  });
});
