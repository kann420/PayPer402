/**
 * End to end through the official SDK: Express + `paymentMiddleware` on the seller side,
 * `wrapFetchWithPayment` on the agent side, and an in-process `x402Facilitator` running the
 * PayPal facilitator scheme over in-memory stores.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, type PaymentOption } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware, setSettlementOverrides } from '@x402/express';
import { wrapFetchWithPayment } from '@x402/fetch';
import { PayPalBatchClientScheme } from './client';
import { PAYPAL_NETWORK_FAMILY, PAYPAL_SANDBOX_NETWORK, SCHEME } from './constants';
import { ErrorCode } from './errors';
import { PayPalBatchFacilitatorScheme } from './facilitator';
import { generateAgentKey, type AgentKey } from './keys';
import { localFacilitatorClient } from './local-facilitator';
import { InMemoryAgentRegistry, InMemoryCommitmentLedger } from './memory';
import { PayPalBatchServerScheme } from './server';

const OPERATOR_ID = 'op_e2e';
const AGENT_ID = 'agent_e2e';
const SELLER_ID = 'seller_e2e';

interface Env {
  baseUrl: string;
  server: Server;
  registry: InMemoryAgentRegistry;
  ledger: InMemoryCommitmentLedger;
  agentKey: AgentKey;
  facilitator: x402Facilitator;
}

async function startEnv(): Promise<Env> {
  const agentKey = generateAgentKey();
  const registry = new InMemoryAgentRegistry()
    .addOperator({
      operatorId: OPERATOR_ID,
      walletStatus: 'active',
      caps: { perCall: 25, daily: 100, unsettled: 50 },
    })
    .addAgent({
      agentId: AGENT_ID,
      kid: agentKey.kid,
      publicKeyX: agentKey.publicKeyX,
      operatorId: OPERATOR_ID,
      status: 'active',
    });
  const ledger = new InMemoryCommitmentLedger();

  const facilitator = new x402Facilitator().register(
    PAYPAL_SANDBOX_NETWORK,
    new PayPalBatchFacilitatorScheme({ agents: registry, ledger }),
  );
  const resourceServer = new x402ResourceServer(localFacilitatorClient(facilitator)).register(
    PAYPAL_NETWORK_FAMILY,
    new PayPalBatchServerScheme(),
  );
  await resourceServer.initialize();

  const accepts = (price: string): PaymentOption => ({
    scheme: SCHEME,
    network: PAYPAL_SANDBOX_NETWORK,
    payTo: SELLER_ID,
    price,
  });
  const app = express();
  app.use(
    paymentMiddleware(
      {
        'GET /paid': { accepts: accepts('$0.05') },
        'GET /dynamic': { accepts: accepts('$0.10') },
      },
      resourceServer,
    ),
  );
  app.get('/paid', (_req, res) => {
    res.json({ quote: 42 });
  });
  app.get('/dynamic', (_req, res) => {
    setSettlementOverrides(res, { amount: '4' });
    res.json({ summary: 'short' });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, server, registry, ledger, agentKey, facilitator };
}

function payingFetch(key: AgentKey, commitmentIds: string[] = []) {
  const client = new x402Client()
    .register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: key.privateKey }))
    .onAfterPaymentCreation(async ({ paymentPayload }) => {
      const commitment = paymentPayload.payload['commitment'] as { id: string };
      commitmentIds.push(commitment.id);
    });
  return wrapFetchWithPayment(fetch, client);
}

function requiredError(res: Response): string | undefined {
  return decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '').error;
}

describe('end to end: paymentMiddleware + wrapFetchWithPayment on paypal:sandbox', () => {
  let env: Env;

  beforeEach(async () => {
    env = await startEnv();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => env.server.close(() => resolve()));
  });

  it('facilitator advertises the PayPal kind on the concrete network', () => {
    expect(env.facilitator.getSupported()).toEqual({
      kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: 'paypal:sandbox', extra: { version: '1.0.0' } }],
      extensions: [],
      signers: { 'paypal:*': [] },
    });
  });

  it('happy path: 402, then pays and records exactly one 5-cent commitment', async () => {
    const unpaid = await fetch(`${env.baseUrl}/paid`);
    expect(unpaid.status).toBe(402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get('PAYMENT-REQUIRED') ?? '');
    expect(required.accepts).toEqual([
      {
        scheme: 'batch-settlement',
        network: 'paypal:sandbox',
        asset: 'USD',
        amount: '5',
        payTo: SELLER_ID,
        maxTimeoutSeconds: 300,
        extra: { version: '1.0.0' },
      },
    ]);

    const ids: string[] = [];
    const res = await payingFetch(env.agentKey, ids)(`${env.baseUrl}/paid`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quote: 42 });
    const settled = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '');
    expect(ids).toHaveLength(1);
    expect(settled).toMatchObject({
      success: true,
      transaction: ids[0],
      network: 'paypal:sandbox',
      payer: AGENT_ID,
      amount: '5',
    });

    const records = env.ledger.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: ids[0],
      agentId: AGENT_ID,
      operatorId: OPERATOR_ID,
      payTo: SELLER_ID,
      amount: 5,
      maxAmount: 5,
      state: 'unsettled',
    });
    expect(records[0]?.resourceUrl).toContain('/paid');
  });

  it('dynamic price: records the override amount under the advertised maximum', async () => {
    const res = await payingFetch(env.agentKey)(`${env.baseUrl}/dynamic`);
    expect(res.status).toBe(200);
    expect(decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '').amount).toBe('4');
    expect(env.ledger.all()).toEqual([expect.objectContaining({ amount: 4, maxAmount: 10 })]);
  });

  it('unsettled cap: $0.10 calls succeed until the cap of 50 cents would be exceeded, then 402', async () => {
    const pay = payingFetch(env.agentKey);
    // Each /dynamic call advertises 10 cents (checked at verify) and records 4 (the override).
    // Verify passes while unsettled + 10 <= 50, so calls succeed at 0, 4, ..., 40 cents unsettled:
    // 11 calls, 44 cents. The 12th call would reach 54 and is refused.
    let successes = 0;
    let blocked: Response | undefined;
    for (let i = 0; i < 20 && !blocked; i += 1) {
      const res = await pay(`${env.baseUrl}/dynamic`);
      if (res.status === 200) successes += 1;
      else blocked = res;
    }
    expect(successes).toBe(11);
    expect(blocked?.status).toBe(402);
    expect(blocked && requiredError(blocked)).toBe(ErrorCode.capExceeded);
    expect(env.ledger.size).toBe(11);
    expect(env.ledger.all().reduce((sum, r) => sum + r.amount, 0)).toBe(44);
  });

  it('unsettled cap at the fixed price: ten 5-cent calls fill the cap exactly, the 11th is refused', async () => {
    const pay = payingFetch(env.agentKey);
    for (let i = 0; i < 10; i += 1) {
      expect((await pay(`${env.baseUrl}/paid`)).status).toBe(200);
    }
    const blocked = await pay(`${env.baseUrl}/paid`);
    expect(blocked.status).toBe(402);
    expect(requiredError(blocked)).toBe(ErrorCode.capExceeded);
    expect(env.ledger.all().reduce((sum, r) => sum + r.amount, 0)).toBe(50);
  });

  it('revoked wallet: the next call gets 402 wallet_revoked and the ledger is unchanged', async () => {
    const pay = payingFetch(env.agentKey);
    expect((await pay(`${env.baseUrl}/paid`)).status).toBe(200);
    env.registry.setWalletStatus(OPERATOR_ID, 'revoked');
    const res = await pay(`${env.baseUrl}/paid`);
    expect(res.status).toBe(402);
    expect(requiredError(res)).toBe(ErrorCode.walletRevoked);
    expect(env.ledger.size).toBe(1);
  });

  it('unknown agent: a client with an unregistered key gets 402 unknown_agent', async () => {
    const res = await payingFetch(generateAgentKey())(`${env.baseUrl}/paid`);
    expect(res.status).toBe(402);
    expect(requiredError(res)).toBe(ErrorCode.unknownAgent);
    expect(env.ledger.size).toBe(0);
  });
});
