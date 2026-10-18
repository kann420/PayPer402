import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { apiError, networkError } from '@payper402/facilitator/test-support';
import { importPrivateKeyRaw, publicKeyX } from '@payper402/scheme-paypal';
import { body, createWebHarness, type WebHarness } from '../test-support';
import {
  createAgentsHandler,
  createCapsHandler,
  createLinkHandler,
  createPatchAgentHandler,
  createRefreshHandler,
  createUnlinkHandler,
} from './operator';
import { createSessionHandler } from './session';

let w: WebHarness;
let operatorId: string;
beforeEach(async () => {
  w = await createWebHarness();
  w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'operator' } })));
  operatorId = w.session()?.operator?.id as string;
});
afterEach(async () => {
  w.h.checkInvariants();
  await w.close();
});

const createAgent = async (name: string) => w.keep(await createAgentsHandler(w.deps)(w.request('/api/operator/agents', { body: { name } })));

describe('POST /api/operator/agents', () => {
  it('registers only the public key, returns the seed once, and keeps it in the session', async () => {
    const res = await createAgent('research-bot');
    expect(res.status).toBe(201);
    const json = (await body(res)) as { agent: { id: string; name: string; keyFingerprint: string }; key: { seed: string; jwk: { x: string; d: string }; fingerprint: string } };
    expect(json.agent.name).toBe('research-bot');
    expect(json.key.seed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(json.key.jwk.d).toBe(json.key.seed);
    expect(json.key.fingerprint).toBe(json.agent.keyFingerprint);
    // The facilitator stores the public key only.
    const row = w.h.db.prepare('SELECT * FROM agents WHERE id = ?').get(json.agent.id) as Record<string, unknown>;
    expect(row['public_key_x']).toBe(publicKeyX(importPrivateKeyRaw(json.key.seed)));
    expect(JSON.stringify(row)).not.toContain(json.key.seed);
    const audit = w.h.db.prepare(`SELECT details FROM audit_log WHERE action = 'agent.created'`).get() as { details: string };
    expect(JSON.parse(audit.details)).toEqual({ generatedKey: false });
    // The session holds the seed.
    expect(w.session()?.agents).toEqual([{ id: json.agent.id, name: 'research-bot', seed: json.key.seed }]);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('drops the oldest key from the session after the fifth agent; the agent itself stays', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(((await body(await createAgent(`bot-${i}`))) as { agent: { id: string } }).agent.id);
    expect(w.session()?.agents.map((a) => a.id)).toEqual(ids.slice(1));
    expect((w.h.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE operator_id = ?').get(operatorId) as { n: number }).n).toBe(6);
  });

  it('validates the name, and needs an operator session and the same origin', async () => {
    const bad = await createAgent('Research Bot');
    expect(bad.status).toBe(400);
    expect(await body(bad)).toMatchObject({ error: 'validation_failed' });
    const foreign = await createAgentsHandler(w.deps)(w.request('/api/operator/agents', { body: { name: 'x' }, origin: 'http://evil.example' }));
    expect(foreign.status).toBe(403);
    const noSession = await createAgentsHandler(w.deps)(w.request('/api/operator/agents', { body: { name: 'x' }, cookie: null }));
    expect(noSession.status).toBe(401);
    expect(await body(noSession)).toMatchObject({ error: 'no_session' });
  });

  it('pauses and resumes through PATCH', async () => {
    const id = ((await body(await createAgent('bot'))) as { agent: { id: string } }).agent.id;
    const res = await createPatchAgentHandler(w.deps)(w.request(`/api/operator/agents/${id}`, { method: 'PATCH', body: { status: 'paused' } }), id);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ agent: { id, status: 'paused', blockReason: 'wallet_not_active' } });
  });
});

describe('POST /api/operator/wallet/unlink', () => {
  const unlink = async () => createUnlinkHandler(w.deps)(w.request('/api/operator/wallet/unlink', { body: {} }));
  let agentId: string;
  beforeEach(() => {
    agentId = w.h.addAgent(operatorId).agentId;
    w.h.activateWallet(operatorId);
    w.h.addCommitment({ operatorId, agentId, payTo: w.sellerId, amount: 8 });
  });

  it('answers 200 with the wallet once the final charge completes', async () => {
    const res = await unlink();
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ wallet: { status: 'not_linked' } });
  });

  it('passes 409 settlement_failed through with the wallet, for the declined copy', async () => {
    w.h.paypal.chargeScripts.push(() => {
      throw apiError(422, ['INSTRUMENT_DECLINED']);
    });
    const res = await unlink();
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ error: 'settlement_failed', wallet: { status: 'active' } });
  });

  it('passes 409 settlement_in_progress through', async () => {
    w.h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    const res = await unlink();
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ error: 'settlement_in_progress', wallet: { status: 'unlinking' } });
  });
});

describe('PUT /api/operator/caps', () => {
  const put = async (payload: unknown) => createCapsHandler(w.deps)(w.request('/api/operator/caps', { method: 'PUT', body: payload }));

  it('sends all four fields and answers the caps', async () => {
    const res = await put({ perCall: 10, daily: 1000, unsettled: 500, total: null });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ caps: { perCall: 10, daily: 1000, unsettled: 500 } });
  });

  it('maps a facilitator 400 back to field issues', async () => {
    const res = await put({ perCall: 50, daily: 1000, unsettled: 20, total: null });
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ error: 'validation_failed', issues: [{ path: 'unsettled', message: 'unsettled must be at least perCall' }] });
  });

  it('refuses a body without all four fields', async () => {
    expect((await put({ perCall: 10, daily: 1000, unsettled: 500 })).status).toBe(400);
  });
});

describe('POST /api/operator/wallet/refresh', () => {
  it('finishes a waiting link whose setup token turned VAULTED (design spec §10.13, facilitator §8 step 2)', async () => {
    const link = await createLinkHandler(w.deps)(w.request('/api/operator/wallet/link', { body: {} }));
    const setupToken = new URL(((await body(link)) as { approveUrl: string }).approveUrl).searchParams.get('token') as string;
    const state = w.h.wallet(operatorId).link_state as string;
    // An earlier attempt created the payment token, but its result was never stored.
    const lost = await w.h.paypal.createPaymentToken(setupToken, state);
    expect(w.h.paypal.setupTokens.get(setupToken)).toBe('VAULTED');
    expect(w.h.wallet(operatorId).status).toBe('waiting_for_approval');

    const res = await createRefreshHandler(w.deps)(w.request('/api/operator/wallet/refresh', { body: {} }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ wallet: { status: 'active', payerEmailMasked: 'bu***@example.com' } });
    expect(w.h.services.ctx.box.open(w.h.wallet(operatorId).vault_id_sealed ?? '')).toBe(lost.id);
  });

  it('answers 200 with link_failed when the payment-token step fails for good', async () => {
    const link = await createLinkHandler(w.deps)(w.request('/api/operator/wallet/link', { body: {} }));
    w.h.paypal.approve(new URL(((await body(link)) as { approveUrl: string }).approveUrl).searchParams.get('token') as string);
    w.h.paypal.createPaymentToken = async () => {
      throw apiError(422, ['INVALID_SETUP_TOKEN'], { path: '/v3/vault/payment-tokens' });
    };
    const res = await createRefreshHandler(w.deps)(w.request('/api/operator/wallet/refresh', { body: {} }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ wallet: { status: 'link_failed', linkError: 'payment_token_failed' } });
  });
});
