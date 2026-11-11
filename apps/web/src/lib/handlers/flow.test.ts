/**
 * The whole flow through the web route handlers (build spec exit criterion 3): the facilitator
 * harness (fake PayPal), the real demo seller app (fake AI) and a scripted Claude. Nothing here
 * reaches PayPal, Anthropic or TypeSafe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { openSession, runAgent, type OpenSessionOptions } from '@payper402/agent';
import { fakeAnthropic, message, toolUse } from '@payper402/agent/test-support';
import { RunRegistry, parseSse } from '../runs';
import { body, createWebHarness, type WebHarness } from '../test-support';
import { createCapsHandler, createAgentsHandler, createLinkHandler, createRefreshHandler, createSettleHandler } from './operator';
import { createRunsHandler, type RunDeps } from './runs';
import { createSessionHandler } from './session';

let w: WebHarness;
afterEach(async () => {
  w.h.checkInvariants();
  await w.close();
});

const call = (service_id: string, params: Record<string, unknown>, reason: string) => toolUse('call_service', { service_id, params, reason });
const finish = (answer: string) => toolUse('finish', { answer, spend_explanation: 'I paid for what the task needed.' });

describe('the web app flow', () => {
  it('sign in, link, caps, agent, a paid run, Charge now for exactly the sum, revocation, then exactly one refusal', async () => {
    w = await createWebHarness({ withSeller: true });
    w.h.clock.now = Math.floor(Date.now() / 1000);
    const deps = w.deps;
    const post = async (handler: (r: Request) => Promise<Response>, path: string, payload: unknown = {}, method = 'POST') =>
      w.keep(await handler(w.request(path, { body: payload, method })));

    // 1. Sign in: a fresh demo operator.
    const signIn = await post(createSessionHandler(deps), '/api/session', { role: 'operator' });
    expect(await body(signIn)).toEqual({ next: '/app/onboarding/link' });
    const operatorId = w.session()?.operator?.id as string;

    // 2. Link: the setup token, the payer approves on PayPal, the page polls /refresh.
    const link = await post(createLinkHandler(deps), '/api/operator/wallet/link');
    const { approveUrl } = (await body(link)) as { approveUrl: string };
    const setupToken = new URL(approveUrl).searchParams.get('token') as string;
    w.h.paypal.approve(setupToken);
    const refreshed = await post(createRefreshHandler(deps), '/api/operator/wallet/refresh');
    expect(await body(refreshed)).toMatchObject({ wallet: { status: 'active', payerEmailMasked: expect.any(String) } });
    const paymentToken = [...w.h.paypal.paymentTokens][0] as string;

    // 3. Caps.
    const caps = await post(createCapsHandler(deps), '/api/operator/caps', { perCall: 10, daily: 1000, unsettled: 500, total: null }, 'PUT');
    expect(await body(caps)).toEqual({ caps: { perCall: 10, daily: 1000, unsettled: 500 } });

    // 4. An agent, with its key kept in the session.
    const agent = (await body(await post(createAgentsHandler(deps), '/api/operator/agents', { name: 'research-bot' }))) as { agent: { id: string } };
    expect(w.session()?.agents.map((a) => a.id)).toEqual([agent.agent.id]);

    // 5. A run that pays two services.
    const sellerUrl = w.seller?.url as string;
    const first = fakeAnthropic([
      message([{ type: 'text', text: 'I will check the rates, then the reviews.' }, toolUse('list_services', {})]),
      message([call('hotel_rates', { hotelId: 'higashiyama-stone-garden-inn', checkIn: '2027-03-30', checkOut: '2027-04-02' }, 'Current price')]),
      message([call('review_summary', { hotelId: 'higashiyama-stone-garden-inn', focus: 'noise at night' }, 'Is it quiet')]),
      message([finish('The Stone Garden Inn fits (simulated data).')]),
    ]);
    const registry = new RunRegistry();
    const runDeps = (client: ReturnType<typeof fakeAnthropic>['client']): RunDeps => ({
      registry,
      anthropic: () => client,
      runAgent,
      openSession: (options: OpenSessionOptions) => openSession({ ...options, nowSeconds: () => w.h.clock.now }),
    });
    const runBody = { agentId: agent.agent.id, task: 'Find me a quiet hotel in Kyoto', budget: '1.00' };
    const run1 = parseSse(await (await createRunsHandler(deps, runDeps(first.client))(w.request('/api/runs', { body: runBody }))).text());
    expect(run1.at(-1)).toEqual({ event: 'end', data: { status: 'completed' } });
    const paid = run1.filter((f) => f.event === 'agent' && (f.data as { type: string }).type === 'paid').map((f) => f.data as { commitmentId: string; amountCents: number });
    expect(paid.map((p) => p.amountCents)).toEqual([1, 5]);

    // 6. Charge now captures exactly the sum of the run's paid calls.
    const charge = await post(createSettleHandler(deps), '/api/operator/settlements');
    expect(charge.status).toBe(201);
    expect(await body(charge)).toMatchObject({ settlement: { status: 'completed', amount: 6, callsCount: 2 } });
    expect(w.h.paypal.callsOf('chargeVaultedWallet')).toEqual([[expect.objectContaining({ amountCents: 6 })]]);
    const settled = w.h.db.prepare(`SELECT id FROM commitments WHERE operator_id = ? AND state = 'settled'`).all(operatorId) as { id: string }[];
    expect(new Set(settled.map((c) => c.id))).toEqual(new Set(paid.map((p) => p.commitmentId)));

    // 7. The payer stops the agreement at PayPal; the webhook revokes the wallet.
    const webhook = await w.h.api('POST', '/webhooks/paypal', {
      headers: { 'paypal-transmission-sig': 'valid', 'paypal-transmission-id': 'tx-web-flow' },
      body: { id: 'WH-WEB-FLOW', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: paymentToken } },
    });
    expect(webhook.status).toBe(200);
    expect(w.h.wallet(operatorId).status).toBe('stopped_by_payer');

    // 8. A second run gets exactly one refusal, wallet_revoked; the next call is answered locally.
    const second = fakeAnthropic([
      message([call('hotel_rates', { hotelId: 'higashiyama-stone-garden-inn', checkIn: '2027-03-30', checkOut: '2027-04-02' }, 'Current price')]),
      message([call('hotel_rates', { hotelId: 'gion-lantern-house', checkIn: '2027-03-30', checkOut: '2027-04-02' }, 'Another hotel')]),
      message([finish('Payments were refused: the PayPal link was stopped.')]),
    ]);
    const run2 = parseSse(await (await createRunsHandler(deps, runDeps(second.client))(w.request('/api/runs', { body: runBody }))).text());
    const refused = run2.filter((f) => f.event === 'agent' && (f.data as { type: string }).type === 'refused').map((f) => f.data);
    expect(refused).toEqual([expect.objectContaining({ code: 'wallet_revoked', by: 'facilitator', note: "Payment required: the operator's PayPal link was stopped." })]);
    const result = run2.find((f) => f.event === 'agent' && (f.data as { type: string }).type === 'result')?.data as { report: { spentCents: number } };
    expect(result.report.spentCents).toBe(0);
    expect(w.h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(1);
  });
});
