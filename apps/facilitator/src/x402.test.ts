import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, HTTPFacilitatorClient } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { paymentMiddleware } from '@x402/express';
import { wrapFetchWithPayment } from '@x402/fetch';
import {
  ASSET,
  BINDING_VERSION,
  ErrorCode,
  PAYPAL_NETWORK_FAMILY,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchClientScheme,
  PayPalBatchServerScheme,
  SCHEME,
  buildCommitment,
  signCommitment,
  type AgentKey,
} from '@payper402/scheme-paypal';
import { createHarness, type Harness } from './test-support';

function requirements(payTo: string, amount = '5'): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: PAYPAL_SANDBOX_NETWORK,
    asset: ASSET,
    amount,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { version: BINDING_VERSION },
  };
}

function payment(key: AgentKey, req: PaymentRequirements, iat: number): PaymentPayload {
  const commitment = buildCommitment({
    kid: key.kid,
    network: req.network,
    asset: req.asset,
    payTo: req.payTo,
    maxAmount: req.amount,
    iat,
    exp: iat + 120,
  });
  return {
    x402Version: 2,
    resource: { url: 'https://seller.test/api/quote?q=1' },
    accepted: req,
    payload: { commitment, signature: signCommitment(commitment, key.privateKey) },
  };
}

describe('x402 endpoints', () => {
  let h: Harness;
  let operatorId: string;
  let agentKey: AgentKey;
  let seller: { sellerId: string; key: string };

  beforeEach(() => {
    h = createHarness();
    operatorId = h.addOperator({ caps: { perCall: 25, daily: 1000, unsettled: 100 } }).operatorId;
    h.activateWallet(operatorId);
    agentKey = h.addAgent(operatorId).key;
    seller = h.addSeller();
  });
  afterEach(async () => {
    await h.close();
  });

  const body = (p: PaymentPayload, r: PaymentRequirements) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: r });

  it('advertises the PayPal kind', async () => {
    const res = await h.api('GET', '/x402/supported', { key: seller.key });
    expect(res.body).toEqual({
      kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: 'paypal:sandbox', extra: { version: '1.0.0' } }],
      extensions: [],
      signers: { 'paypal:*': [] },
    });
  });

  it('validates the outer body (400) and requires a seller key (401/403)', async () => {
    const r = requirements(seller.sellerId);
    const p = payment(agentKey, r, h.clock.now);
    for (const bad of [{}, { x402Version: '2', paymentPayload: p, paymentRequirements: r }, { x402Version: 2, paymentPayload: 'x', paymentRequirements: r }]) {
      const res = await h.api('POST', '/x402/verify', { key: seller.key, body: bad });
      expect(res.status).toBe(400);
      expect(res.body['error']).toBe('validation_failed');
    }
    expect((await h.api('POST', '/x402/settle', { key: seller.key, body: { x402Version: 2 } })).status).toBe(400);
    expect((await h.api('POST', '/x402/verify', { body: body(p, r) })).status).toBe(401);
    const operatorKey = h.addOperator().key;
    expect((await h.api('POST', '/x402/settle', { key: operatorKey, body: body(p, r) })).status).toBe(403);
  });

  it('verifies and settles a valid commitment', async () => {
    const r = requirements(seller.sellerId);
    const p = payment(agentKey, r, h.clock.now);
    const verify = await h.api('POST', '/x402/verify', { key: seller.key, body: body(p, r) });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ isValid: true });
    const settle = await h.api('POST', '/x402/settle', { key: seller.key, body: body(p, r) });
    expect(settle.body).toMatchObject({ success: true, amount: '5', network: 'paypal:sandbox' });
    expect(h.commitmentStates(operatorId)).toEqual({ unsettled: 1 });
  });

  it('refuses a payTo that is not the authenticated seller, for verify and settle', async () => {
    const other = h.addSeller();
    const r = requirements(other.sellerId);
    const p = payment(agentKey, r, h.clock.now);
    const verify = await h.api('POST', '/x402/verify', { key: seller.key, body: body(p, r) });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: ErrorCode.requirementsMismatch });
    const settle = await h.api('POST', '/x402/settle', { key: seller.key, body: body(p, r) });
    expect(settle.status).toBe(200);
    expect(settle.body).toMatchObject({ success: false, errorReason: ErrorCode.requirementsMismatch, transaction: '' });
    expect(h.commitmentStates(operatorId)).toEqual({});
  });

  it('refuses a settle retry by a different seller (short-circuit guard)', async () => {
    const r = requirements(seller.sellerId);
    const p = payment(agentKey, r, h.clock.now);
    expect((await h.api('POST', '/x402/settle', { key: seller.key, body: body(p, r) })).body).toMatchObject({ success: true });
    const thief = h.addSeller();
    // The thief claims its own payTo in the requirements but replays the recorded commitment.
    const res = await h.api('POST', '/x402/settle', { key: thief.key, body: body(p, { ...r, payTo: thief.sellerId }) });
    expect(res.body).toMatchObject({ success: false, errorReason: ErrorCode.requirementsMismatch });
    expect(JSON.stringify(res.body)).not.toContain(operatorId);
  });

  it('answers an identical settle retry with the original result, without a new event or threshold check', async () => {
    const r = requirements(seller.sellerId);
    const p = payment(agentKey, r, h.clock.now);
    const first = await h.api('POST', '/x402/settle', { key: seller.key, body: body(p, r) });
    await h.services.settlements.background.idle();
    const eventsAfterFirst = h.seen.filter((e) => e.type === 'commitment.recorded').length;
    const chargesAfterFirst = h.paypal.callsOf('chargeVaultedWallet').length;
    let scheduled = 0;
    const original = h.services.settlements.scheduleThresholdCheck.bind(h.services.settlements);
    h.services.settlements.scheduleThresholdCheck = (id: string) => {
      scheduled += 1;
      original(id);
    };
    const retry = await h.api('POST', '/x402/settle', { key: seller.key, body: body(p, r) });
    expect(retry.body['transaction']).toBe(first.body['transaction']);
    expect(retry.body['success']).toBe(true);
    expect(h.seen.filter((e) => e.type === 'commitment.recorded')).toHaveLength(eventsAfterFirst);
    expect(scheduled).toBe(0);
    expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(chargesAfterFirst);
    expect(eventsAfterFirst).toBe(1);
  });

  it('answers payment-level failures with 200 and the binding codes', async () => {
    const r = requirements(seller.sellerId);
    const unknown = payment((await import('@payper402/scheme-paypal')).generateAgentKey(), r, h.clock.now);
    const res = await h.api('POST', '/x402/verify', { key: seller.key, body: body(unknown, r) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isValid: false, invalidReason: ErrorCode.unknownAgent });
    const wrongNetwork = { ...r, network: 'eip155:1' as const };
    const res2 = await h.api('POST', '/x402/settle', { key: seller.key, body: body(payment(agentKey, wrongNetwork, h.clock.now), wrongNetwork) });
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ success: false, errorReason: ErrorCode.requirementsMismatch, network: 'paypal:sandbox' });
    const v1 = { ...payment(agentKey, r, h.clock.now), x402Version: 1 };
    const res3 = await h.api('POST', '/x402/verify', { key: seller.key, body: body(v1, r) });
    expect(res3.body).toMatchObject({ isValid: false, invalidReason: ErrorCode.payload });
  });

  it('emits commitment.recorded from the ledger hook', async () => {
    const r = requirements(seller.sellerId);
    await h.api('POST', '/x402/settle', { key: seller.key, body: body(payment(agentKey, r, h.clock.now), r) });
    expect(h.seen.find((e) => e.type === 'commitment.recorded')).toMatchObject({
      operatorId,
      data: { payTo: seller.sellerId, path: '/api/quote?q=1', amount: 5, recordedAt: h.clock.now },
    });
  });
});

describe('x402 end to end over HTTP', () => {
  let h: Harness;
  let sellerServer: Server;
  let sellerUrl: string;
  let operatorId: string;
  let agentKey: AgentKey;

  beforeEach(async () => {
    h = createHarness();
    // Threshold = unsettled - perCall = 15 cents: the 3rd 5-cent call triggers a settlement.
    operatorId = h.addOperator({ caps: { perCall: 5, daily: 1000, unsettled: 20 } }).operatorId;
    h.activateWallet(operatorId, 'PT-E2E');
    agentKey = h.addAgent(operatorId).key;
    const seller = h.addSeller();
    const facilitatorUrl = await h.url();
    const headers = { Authorization: `Bearer ${seller.key}` };
    const resourceServer = new x402ResourceServer(
      new HTTPFacilitatorClient({
        url: `${facilitatorUrl}/x402`,
        createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
      }),
    ).register(PAYPAL_NETWORK_FAMILY, new PayPalBatchServerScheme());
    await resourceServer.initialize();
    const app = express();
    app.use(
      paymentMiddleware(
        { 'GET /paid': { accepts: { scheme: SCHEME, network: PAYPAL_SANDBOX_NETWORK, payTo: seller.sellerId, price: '$0.05' } } },
        resourceServer,
      ),
    );
    app.get('/paid', (_req, res) => {
      res.json({ quote: 42 });
    });
    sellerServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    sellerUrl = `http://127.0.0.1:${(sellerServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    sellerServer.closeAllConnections();
    await new Promise<void>((resolve) => sellerServer.close(() => resolve()));
    await h.close();
  });

  const agentFetch = () =>
    wrapFetchWithPayment(
      fetch,
      new x402Client().register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: agentKey.privateKey, now: () => h.clock.now })),
    );

  it('402, then 200; records commitments; a threshold settlement charges PayPal; revocation then gives 402 wallet_revoked', async () => {
    const unpaid = await fetch(`${sellerUrl}/paid`);
    expect(unpaid.status).toBe(402);

    const pay = agentFetch();
    const first = await pay(`${sellerUrl}/paid`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ quote: 42 });
    const receipt = decodePaymentResponseHeader(first.headers.get('PAYMENT-RESPONSE') ?? '');
    expect(receipt).toMatchObject({ success: true, amount: '5', network: 'paypal:sandbox' });
    const row = h.db.prepare('SELECT * FROM commitments WHERE id = ?').get(receipt.transaction) as Record<string, unknown>;
    expect(row).toMatchObject({ operator_id: operatorId, amount: 5, max_amount: 5, state: 'unsettled' });
    expect(h.seen.filter((e) => e.type === 'commitment.recorded')).toHaveLength(1);

    for (let i = 0; i < 2; i += 1) expect((await pay(`${sellerUrl}/paid`)).status).toBe(200);
    await h.services.settlements.background.idle();

    const [settlement] = h.settlements(operatorId);
    expect(settlement).toMatchObject({ trigger: 'threshold', status: 'completed', amount: 15, calls_count: 3 });
    const [charge] = h.paypal.callsOf('chargeVaultedWallet');
    expect(charge?.[0]).toMatchObject({ vaultId: 'PT-E2E', amountCents: 15, requestId: settlement?.id, invoiceId: settlement?.id });
    expect(h.commitmentStates(operatorId)).toEqual({ settled: 3 });
    h.checkInvariants();

    // The payer revokes; the health check notices.
    h.paypal.paymentTokens.delete('PT-E2E');
    await h.services.jobs.runTick();
    expect(h.wallet(operatorId).status).toBe('stopped_by_payer');

    const refused = await pay(`${sellerUrl}/paid`);
    expect(refused.status).toBe(402);
    expect(decodePaymentRequiredHeader(refused.headers.get('PAYMENT-REQUIRED') ?? '').error).toBe(ErrorCode.walletRevoked);
    expect(h.commitmentStates(operatorId)).toEqual({ settled: 3 });
  });
});
