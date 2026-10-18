import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { apiError } from '@payper402/facilitator/test-support';
import { FacilitatorClient, FacilitatorError } from './facilitator';
import { createWebHarness, type WebHarness } from './test-support';

let w: WebHarness;
beforeEach(async () => {
  w = await createWebHarness();
});
afterEach(async () => {
  await w.close();
});

async function rejection(promise: Promise<unknown>): Promise<FacilitatorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FacilitatorError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('facilitator client', () => {
  it('parses every response it uses, captured from the harness', async () => {
    const { h, deps } = w;
    const created = await deps.facilitator.admin(w.config.adminKey as string).createDemoOperator();
    const op = deps.facilitator.operator(created.apiKey);
    const operatorId = created.operator.id;
    const { agentId } = h.addAgent(operatorId);
    h.activateWallet(operatorId);
    h.addCommitment({ operatorId, agentId, payTo: w.sellerId, amount: 3, resourceUrl: 'http://seller.test/v1/quote?symbol=KC' });
    h.addCommitment({ operatorId, agentId, payTo: w.sellerId, amount: 5 });

    const view = await op.get();
    expect(view.usage.chargeable).toBe(8);
    expect(view.blockReason).toBeNull();
    const settled = await op.settle();
    expect(settled.settlement).toMatchObject({ status: 'completed', amount: 8 });
    h.addCommitment({ operatorId, agentId, payTo: w.sellerId, amount: 2 });
    expect((await op.agents()).agents[0]).toMatchObject({ id: agentId, blockReason: null });
    expect((await op.agent(agentId)).agent.id).toBe(agentId);
    expect((await op.patchAgent(agentId, { status: 'paused' })).agent.status).toBe('paused');
    expect((await op.commitments({ limit: 10 })).commitments).toHaveLength(3);
    expect((await op.settlements({ limit: 10 })).settlements).toHaveLength(1);
    expect((await op.settlement(settled.settlement.id)).settlement.commitments).toHaveLength(2);
    expect((await op.putCaps({ perCall: 10, daily: 1000, unsettled: 500, total: null })).caps).toEqual({ perCall: 10, daily: 1000, unsettled: 500 });

    const seller = deps.facilitator.seller(w.sellerKey);
    expect((await seller.get()).usage).toMatchObject({ pending: 2, pendingCalls: 1 });
    expect((await seller.commitments({ limit: 10 })).commitments[0]?.agentRef).toMatch(/^[0-9a-f]{8}$/);
    expect((await seller.settlements({ limit: 10 })).settlements[0]).toMatchObject({ sellerAmount: 8, sellerCalls: 2 });

    const link = await op.link().catch((e: unknown) => e);
    expect(link).toBeInstanceOf(FacilitatorError);
    expect((link as FacilitatorError).code).toBe('wallet_already_active');
  });

  it('maps an operator 401 to session_ended', async () => {
    const error = await rejection(w.deps.facilitator.operator(`pp402_op_${'x'.repeat(43)}`).get());
    expect(error).toMatchObject({ status: 401, code: 'session_ended' });
  });

  it('maps a seller-key 401 to 503 seller_unavailable, with a log line', async () => {
    const error = await rejection(w.deps.facilitator.seller(`pp402_sel_${'x'.repeat(43)}`).get());
    expect(error).toMatchObject({ status: 503, code: 'seller_unavailable' });
    expect(w.logs.some((l) => l.includes('seller key'))).toBe(true);
  });

  it('passes 409 codes and bodies through', async () => {
    const created = await w.deps.facilitator.admin(w.config.adminKey as string).createDemoOperator();
    const error = await rejection(w.deps.facilitator.operator(created.apiKey).unlink());
    expect(error.status).toBe(409);
    expect(error.code).toBe('wallet_not_active');
    const charge = await rejection(w.deps.facilitator.operator(created.apiKey).settle());
    expect(charge.code).toBe('wallet_not_active');
  });

  it('passes paypal_unavailable through', async () => {
    const created = await w.deps.facilitator.admin(w.config.adminKey as string).createDemoOperator();
    w.h.paypal.createSetupToken = async () => {
      throw apiError(500);
    };
    const error = await rejection(w.deps.facilitator.operator(created.apiKey).link());
    expect(error).toMatchObject({ status: 502, code: 'paypal_unavailable' });
  });

  it('maps 5xx and bad shapes to upstream_error with the request id as ref', async () => {
    const fake = (async () => new Response('{"error":"internal_error"}', { status: 500, headers: { 'x-request-id': 'req_abc' } })) as typeof fetch;
    const client = new FacilitatorClient({ baseUrl: 'http://f.test', fetch: fake, log: () => {} });
    const error = await rejection(client.operator('k').get());
    expect(error).toMatchObject({ status: 502, code: 'upstream_error', ref: 'req_abc' });
    expect(error.toJSON()).toMatchObject({ error: 'upstream_error', ref: 'req_abc' });

    const shape = (async () => new Response('{"operator":1}', { status: 200, headers: { 'x-request-id': 'req_def' } })) as typeof fetch;
    const bad = await rejection(new FacilitatorClient({ baseUrl: 'http://f.test', fetch: shape, log: () => {} }).operator('k').get());
    expect(bad).toMatchObject({ code: 'upstream_error', ref: 'req_def' });

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await rejection(new FacilitatorClient({ baseUrl: 'http://f.test', fetch: down, log: () => {} }).operator('k').get())).toMatchObject({
      code: 'upstream_error',
    });
  });
});
