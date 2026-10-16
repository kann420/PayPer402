import { decodePaymentResponseHeader, encodePaymentResponseHeader, FacilitatorResponseError } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import { setSettlementOverrides } from '@x402/express';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, generateAgentKey } from '@payper402/scheme-paypal';
import type { AgentEvent } from './events';
import { openSession, type OpenSessionOptions } from './session';
import { DEMO_PAY_TO, OPERATOR, demoService, fetchSpy, startCustomEnv, startDemoEnv, withHeaders, type Env } from './test-support';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function sessionFor(e: Env, options: Partial<OpenSessionOptions> = {}) {
  return openSession({ sellerUrl: e.url, privateKey: e.key.privateKey, budgetCents: 100, maxPerCallCents: 10, ...options });
}

const types = (events: readonly AgentEvent[]) => events.map((e) => e.type);
const articleUrl = (e: Env) => `${e.url}/news/coffee-highland-rains-delay-harvest`;

describe('paid calls against the demo seller', () => {
  it('happy path: discovered_price, decided, paid, with the ledger id and running totals', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env);
    const quote = await session.call('quote', { symbol: 'KC' }, 'Need the current coffee price');
    expect(quote).toMatchObject({ ok: true, serviceId: 'quote', paidCents: 2 });
    const summary = await session.call('summarize', { url: articleUrl(env) }, 'Top news');
    expect(summary).toMatchObject({ ok: true, paidCents: 5 });
    expect(types(session.events)).toEqual(['discovered_price', 'decided', 'paid', 'discovered_price', 'decided', 'paid']);
    const [discovered, decided, paid] = session.events;
    expect(discovered).toMatchObject({ callId: 'call_1', serviceId: 'quote', serviceName: 'Market Quote API', priceCents: 2, catalogPriceCents: 2 });
    expect(decided).toMatchObject({ callId: 'call_1', priceCents: 2, note: 'Need the current coffee price', remainingCents: 98 });
    const records = env.ledger.all();
    expect(paid).toMatchObject({ callId: 'call_1', amountCents: 2, commitmentId: records[0]?.id, httpStatus: 200, spentCents: 2, remainingCents: 98 });
    expect(session.events[5]).toMatchObject({ callId: 'call_2', amountCents: 5, commitmentId: records[1]?.id, spentCents: 7, remainingCents: 93 });
    expect(quote.ok && quote.commitmentId).toBe(records[0]?.id);
    expect(quote.ok && (quote.data as { symbol: string }).symbol).toBe('KC');
    for (const event of session.events) expect(typeof event.at).toBe('number');
  });

  it('refuses locally, with no request, when the catalog price is above maxPerCall or the remaining budget', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy();
    const session = await sessionFor(env, { fetch: spy.fetch, budgetCents: 6, maxPerCallCents: 5 });
    expect(await session.call('premium_news', { topic: 'coffee' }, 'Full coverage')).toMatchObject({
      ok: false,
      error: 'refused',
      code: 'over_per_call_limit',
      message: 'Over the per-call limit',
    });
    expect(await session.call('summarize', { url: articleUrl(env) }, 'News')).toMatchObject({ ok: true });
    expect(spy.calls).toHaveLength(2);
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: false, code: 'over_budget' });
    expect(spy.calls).toHaveLength(2);
    expect(session.events.filter((e) => e.type === 'refused')).toEqual([
      expect.objectContaining({ code: 'over_per_call_limit', by: 'agent', note: 'Over the per-call limit', serviceId: 'premium_news' }),
      expect.objectContaining({ code: 'over_budget', by: 'agent', note: 'Over the run budget', serviceId: 'quote' }),
    ]);
  });

  it('unknown services and invalid params are tool errors with no request and no event', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy();
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('nope', {}, 'x')).toMatchObject({ ok: false, error: 'unknown_service' });
    expect(await session.call('quote', { symbol: 'KC', extra: 1 }, 'x')).toMatchObject({
      ok: false,
      error: 'invalid_params',
      issues: [{ param: 'extra', message: 'unknown param' }],
    });
    expect(spy.calls).toHaveLength(0);
    expect(session.events).toHaveLength(0);
  });

  describe('facilitator refusals', () => {
    it('cap_exceeded', async () => {
      env = await startDemoEnv({ caps: { perCall: 1, daily: 1000, unsettled: 1000 } });
      const session = await sessionFor(env);
      expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: false, error: 'refused', code: 'cap_exceeded' });
      expect(session.events.at(-1)).toMatchObject({ type: 'refused', code: 'cap_exceeded', by: 'facilitator', note: "Over the operator's spending limit" });
      expect(session.budget()).toMatchObject({ reservedCents: 0, spentCents: 0, remainingCents: 100 });
      expect(session.blocked).toBe(false);
    });

    it('wallet_revoked blocks the session; the next call is payments_blocked with no HTTP request', async () => {
      env = await startDemoEnv();
      env.registry.setWalletStatus(OPERATOR, 'revoked');
      const spy = fetchSpy();
      const session = await sessionFor(env, { fetch: spy.fetch });
      expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'wallet_revoked' });
      expect(session.events.at(-1)).toMatchObject({ note: "Payment required: the operator's PayPal link was stopped." });
      expect(session.blocked).toBe(true);
      const requests = spy.calls.length;
      expect(await session.call('quote', { symbol: 'CC' }, 'Price')).toMatchObject({ ok: false, error: 'payments_blocked' });
      expect(spy.calls).toHaveLength(requests);
      expect(session.events.filter((e) => e.type === 'refused')).toHaveLength(1);
    });

    it('agent_disabled (a paused agent) blocks', async () => {
      env = await startDemoEnv();
      env.registry.setAgentStatus(env.key.kid, 'disabled');
      const session = await sessionFor(env);
      expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'agent_disabled', message: 'This agent is paused' });
      expect(session.blocked).toBe(true);
    });

    it('unknown_agent', async () => {
      env = await startDemoEnv();
      const session = await sessionFor(env, { privateKey: generateAgentKey().privateKey });
      expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'unknown_agent' });
      expect(session.blocked).toBe(true);
      expect(env.ledger.size).toBe(0);
    });
  });

  it('a 400 after a valid payment: failed, charged no, released, no ledger record', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env);
    expect(await session.call('summarize', { url: 'https://elsewhere.example/news/x' }, 'News')).toMatchObject({
      ok: false,
      error: 'failed',
      message: 'The service answered HTTP 400 (unsupported_url)',
    });
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'no', callId: 'call_1' });
    expect(session.budget()).toMatchObject({ reservedCents: 0, spentCents: 0, uncertainCents: 0, remainingCents: 100 });
    expect(env.ledger.size).toBe(0);
  });

  it('a 503 from the handler (AI failure) after a valid payment: failed, charged no, released', async () => {
    env = await startDemoEnv();
    env.ai.fail = true;
    const session = await sessionFor(env);
    expect(await session.call('translate', { text: 'Hi', targetLanguage: 'vi' }, 'Translate')).toMatchObject({
      message: 'The service answered HTTP 503 (ai_unavailable)',
    });
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'no' });
    expect(session.budget().remainingCents).toBe(100);
    expect(env.ledger.size).toBe(0);
  });

  it('a network error after the paid request was sent: failed, charged unknown, counted as uncertain', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy((res, init) => {
      if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) throw new TypeError('fetch failed');
      return res;
    });
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: false, error: 'failed', message: 'The payment outcome is unknown' });
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'unknown' });
    expect(session.budget()).toMatchObject({ uncertainCents: 2, spentCents: 0, remainingCents: 98 });
    expect(session.report().uncertainCents).toBe(2);
  });

  it('a probe 402 without PAYMENT-REQUIRED: failed, charged no, nothing reserved', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy((res, init) =>
      new Headers(init?.headers).has('PAYMENT-SIGNATURE') ? res : withHeaders(res, (h) => h.delete('PAYMENT-REQUIRED')),
    );
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ message: 'The service sent an unreadable 402' });
    expect(session.events).toEqual([expect.objectContaining({ type: 'failed', charged: 'no' })]);
    expect(session.budget().reservedCents).toBe(0);
    expect(spy.calls).toHaveLength(1);
  });

  it('an over-reported settle amount: paid with the reserved amount, then failed with the note', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy((res, init) => {
      if (!new Headers(init?.headers).has('PAYMENT-SIGNATURE')) return res;
      return withHeaders(res, (h) => {
        const settled = decodePaymentResponseHeader(h.get('PAYMENT-RESPONSE') ?? '');
        h.set('PAYMENT-RESPONSE', encodePaymentResponseHeader({ ...settled, amount: '50' }));
      });
    });
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: true, paidCents: 2 });
    expect(types(session.events)).toEqual(['discovered_price', 'decided', 'paid', 'failed']);
    expect(session.events[2]).toMatchObject({ amountCents: 2, spentCents: 2 });
    expect(session.events[3]).toMatchObject({ note: 'The seller reported a higher amount than the signed maximum', callId: 'call_1' });
    expect(env.ledger.all()[0]?.amount).toBe(2);
  });

  it('a missing PAYMENT-RESPONSE on a 2xx commits the reserved price with a null commitment id', async () => {
    env = await startDemoEnv();
    const spy = fetchSpy((res, init) =>
      new Headers(init?.headers).has('PAYMENT-SIGNATURE') ? withHeaders(res, (h) => h.delete('PAYMENT-RESPONSE')) : res,
    );
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: true, paidCents: 2, commitmentId: null });
    expect(session.events.at(-1)).toMatchObject({ type: 'paid', amountCents: 2, commitmentId: null });
    expect(session.report().commitmentIds).toEqual([]);
  });

  it('parallel calls never exceed the budget', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env, { budgetCents: 7, maxPerCallCents: 5 });
    const results = await Promise.all(Array.from({ length: 10 }, () => session.call('quote', { symbol: 'KC' }, 'Price')));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.code === 'over_budget')).toHaveLength(7);
    expect(session.budget()).toMatchObject({ spentCents: 6, reservedCents: 0, remainingCents: 1 });
    expect(env.ledger.size).toBe(3);
  });

  it('the report: lines, notUsed, refusals, commitment ids, and numbers equal to the event sums', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env);
    await session.call('quote', { symbol: 'KC' }, 'Price');
    await session.call('quote', { symbol: 'CC' }, 'Price');
    await session.call('summarize', { url: articleUrl(env) }, 'News');
    await session.call('premium_news', { topic: 'coffee' }, 'Full');
    const report = session.report('I bought a quote and a summary.');
    const paid = session.events.filter((e): e is Extract<AgentEvent, { type: 'paid' }> => e.type === 'paid');
    expect(report).toEqual({
      sellerName: 'Acme Data',
      budgetCents: 100,
      spentCents: 9,
      uncertainCents: 0,
      remainingCents: 91,
      lines: [
        { serviceId: 'quote', serviceName: 'Market Quote API', calls: 2, unitPriceCents: 2, totalCents: 4 },
        { serviceId: 'summarize', serviceName: 'Page Summary API', calls: 1, unitPriceCents: 5, totalCents: 5 },
      ],
      notUsed: [
        { serviceId: 'translate', serviceName: 'Translate API', priceCents: 1 },
        { serviceId: 'premium_news', serviceName: 'Premium News API', priceCents: 25 },
      ],
      refusals: [{ serviceId: 'premium_news', code: 'over_per_call_limit' }],
      commitmentIds: env.ledger.all().map((r) => r.id),
      explanation: 'I bought a quote and a summary.',
    });
    expect(report.spentCents).toBe(paid.reduce((sum, e) => sum + e.amountCents, 0));
    expect(report.lines.reduce((sum, l) => sum + l.totalCents, 0)).toBe(report.spentCents);
  });

  it('an onEvent that throws does not break the call', async () => {
    env = await startDemoEnv();
    const seen: string[] = [];
    const session = await sessionFor(env, {
      onEvent: (event) => {
        seen.push(event.type);
        throw new Error('observer bug');
      },
    });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: true });
    expect(seen).toEqual(['discovered_price', 'decided', 'paid']);
  });
});

describe('paid calls against test sellers', () => {
  it('price_changed: the 402 asks more than the catalog says', async () => {
    env = await startCustomEnv([
      { service: demoService('quote'), accepts: { price: { asset: 'USD', amount: '3' } }, handler: (_req, res) => void res.json({}) },
    ]);
    const session = await sessionFor(env);
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'price_changed' });
    expect(types(session.events)).toEqual(['discovered_price', 'refused']);
    expect(session.events[0]).toMatchObject({ priceCents: 3, catalogPriceCents: 2 });
    expect(session.events[1]).toMatchObject({ by: 'agent', note: 'The price asked is higher than the catalog price' });
    expect(env.ledger.size).toBe(0);
  });

  it('payee_mismatch: the 402 pays someone other than the catalog payTo', async () => {
    env = await startCustomEnv([{ service: demoService('quote'), accepts: { payTo: 'sel_other' }, handler: (_req, res) => void res.json({}) }]);
    const session = await sessionFor(env);
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'payee_mismatch' });
    expect(session.events).toEqual([
      expect.objectContaining({ type: 'refused', by: 'agent', note: 'The payment recipient does not match the catalog' }),
    ]);
  });

  it('dynamic pricing: a route that settles 3 of 5 cents commits 3', async () => {
    env = await startCustomEnv([
      {
        service: demoService('summarize'),
        handler: (_req, res) => {
          setSettlementOverrides(res, { amount: '3' });
          res.json({ summary: 'short' });
        },
      },
    ]);
    const session = await sessionFor(env);
    expect(await session.call('summarize', { url: 'http://x/news/a' }, 'News')).toMatchObject({ ok: true, paidCents: 3 });
    expect(session.events).toContainEqual(expect.objectContaining({ type: 'decided', priceCents: 5 }));
    expect(session.events.at(-1)).toMatchObject({ type: 'paid', amountCents: 3, spentCents: 3, remainingCents: 97 });
    expect(env.ledger.all()[0]).toMatchObject({ amount: 3, maxAmount: 5 });
  });

  it('a body over 64 KB is replaced by response_too_large, and the call stays paid', async () => {
    env = await startCustomEnv([{ service: demoService('quote'), handler: (_req, res) => void res.json({ blob: 'x'.repeat(70 * 1024) }) }]);
    const session = await sessionFor(env);
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ ok: true, paidCents: 2, data: { error: 'response_too_large' } });
    expect(env.ledger.size).toBe(1);
  });
});

describe('the paid-request 402 table (design spec §4.3 step 6)', () => {
  const wrapper = (overrides: Partial<FacilitatorClient>) => (client: FacilitatorClient): FacilitatorClient => ({ ...client, ...overrides });

  it('a settle refusal with a binding code: refused, released, nothing in the ledger', async () => {
    env = await startDemoEnv({
      wrap: wrapper({
        settle: async () => ({ success: false, errorReason: ErrorCode.capExceeded, transaction: '', network: 'paypal:sandbox' }),
      }),
    });
    const session = await sessionFor(env);
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'cap_exceeded' });
    expect(session.events.at(-1)).toMatchObject({ type: 'refused', by: 'facilitator' });
    expect(session.budget()).toMatchObject({ reservedCents: 0, uncertainCents: 0, remainingCents: 100 });
    expect(env.ledger.size).toBe(0);
  });

  it('a settle that throws in transit: PAYMENT-RESPONSE with a non-binding reason; failed, unknown, uncertain', async () => {
    let paidResponse: { status: number; headers: Headers } | undefined;
    env = await startDemoEnv({
      wrap: wrapper({
        settle: async () => {
          throw new Error('fetch failed');
        },
      }),
    });
    const spy = fetchSpy((res, init) => {
      if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) paidResponse = { status: res.status, headers: new Headers(res.headers) };
      return res;
    });
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ message: 'The payment outcome is unknown' });
    expect(paidResponse?.status).toBe(402);
    const settled = decodePaymentResponseHeader(paidResponse?.headers.get('PAYMENT-RESPONSE') ?? '');
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBeTruthy();
    expect(settled.errorReason?.startsWith('invalid_batch_settlement_paypal_')).toBe(false);
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'unknown' });
    expect(session.budget()).toMatchObject({ uncertainCents: 2, remainingCents: 98 });
  });

  it('a verify refusal with a binding code: refused', async () => {
    env = await startDemoEnv({
      wrap: wrapper({ verify: async () => ({ isValid: false, invalidReason: ErrorCode.expired, invalidMessage: 'late' }) }),
    });
    const session = await sessionFor(env);
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ code: 'payment_rejected' });
    expect(session.events.at(-1)).toMatchObject({ type: 'refused', by: 'facilitator', note: 'The payment was rejected', detail: ErrorCode.expired });
    expect(session.blocked).toBe(false);
    expect(session.budget().remainingCents).toBe(100);
  });

  it('a verify that throws in transit: failed, charged no, released', async () => {
    env = await startDemoEnv({
      wrap: wrapper({
        verify: async () => {
          throw new Error('fetch failed');
        },
      }),
    });
    const session = await sessionFor(env);
    const outcome = await session.call('quote', { symbol: 'KC' }, 'Price');
    expect(outcome).toMatchObject({ ok: false, error: 'failed' });
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'no' });
    expect(session.budget()).toMatchObject({ reservedCents: 0, uncertainCents: 0, remainingCents: 100 });
    expect(env.ledger.size).toBe(0);
  });

  it('neither header on a paid 402: failed, charged unknown (defensive)', async () => {
    env = await startDemoEnv();
    env.registry.setAgentStatus(env.key.kid, 'disabled');
    const spy = fetchSpy((res, init) =>
      new Headers(init?.headers).has('PAYMENT-SIGNATURE')
        ? withHeaders(res, (h) => {
            h.delete('PAYMENT-REQUIRED');
            h.delete('PAYMENT-RESPONSE');
          })
        : res,
    );
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ message: 'The payment outcome is unknown' });
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'unknown' });
    expect(session.budget().uncertainCents).toBe(2);
  });

  it('a 502 (the facilitator answer could not be read at settle): failed, charged unknown', async () => {
    let status: number | undefined;
    env = await startDemoEnv({
      wrap: wrapper({
        settle: async () => {
          throw new FacilitatorResponseError('Facilitator settle returned invalid data');
        },
      }),
    });
    const spy = fetchSpy((res, init) => {
      if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) status = res.status;
      return res;
    });
    const session = await sessionFor(env, { fetch: spy.fetch });
    expect(await session.call('quote', { symbol: 'KC' }, 'Price')).toMatchObject({ message: 'The payment outcome is unknown' });
    expect(status).toBe(502);
    expect(session.events.at(-1)).toMatchObject({ type: 'failed', charged: 'unknown' });
    expect(session.budget().uncertainCents).toBe(2);
  });
});

describe('the paid request payTo', () => {
  it('pays the catalog payTo', async () => {
    env = await startDemoEnv();
    const session = await sessionFor(env);
    await session.call('quote', { symbol: 'KC' }, 'Price');
    expect(env.ledger.all()[0]?.payTo).toBe(DEMO_PAY_TO);
  });
});
