/**
 * Plumbing test: a minimal fake scheme on `paypal:sandbox` must run end to end through the
 * official x402 SDK (`@x402/express` on the server, `@x402/fetch` on the client) before any real
 * binding logic is trusted. It guards the SDK wiring the real scheme relies on.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';
import { paymentMiddleware, setSettlementOverrides } from '@x402/express';
import { wrapFetchWithPayment } from '@x402/fetch';

const NETWORK: Network = 'paypal:sandbox';
const SCHEME_ID = 'batch-settlement';

class FakeClient implements SchemeNetworkClient {
  readonly scheme = SCHEME_ID;
  findDefaultAsset(asset: string, network: Network) {
    return asset === 'USD' && network.startsWith('paypal:')
      ? { asset: 'USD', decimals: 2, symbol: 'USD' }
      : undefined;
  }
  async createPaymentPayload(x402Version: number): Promise<PaymentPayloadResult> {
    return { x402Version, payload: { ok: true } };
  }
}

class FakeServer implements SchemeNetworkServer {
  readonly scheme = SCHEME_ID;
  readonly defaultAssetTransferMethod = 'default';
  readonly paymentFlows = {
    default: { supported: ['authorization'] as const, default: 'authorization' as const },
  };
  async parsePrice(price: Price): Promise<AssetAmount> {
    if (price === '$0.01') return { asset: 'USD', amount: '1' };
    if (price === '$0.02') return { asset: 'USD', amount: '2' };
    throw new Error(`unexpected price ${JSON.stringify(price)}`);
  }
  getAssetDecimals(asset: string): number | undefined {
    return asset === 'USD' ? 2 : undefined;
  }
  async enhancePaymentRequirements(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    // Checks that a scheme may clamp maxTimeoutSeconds here without tripping SDK guards.
    return { ...requirements, maxTimeoutSeconds: Math.min(requirements.maxTimeoutSeconds, 300) };
  }
}

class FakeFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_ID;
  readonly caipFamily = 'paypal:*';
  readonly settled: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];
  private counter = 0;
  getExtra(): Record<string, unknown> | undefined {
    return undefined;
  }
  getSigners(): string[] {
    return [];
  }
  async verify(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (requirements.payTo === 'seller_verify_fail') {
      return { isValid: false, invalidReason: 'fake_verify_failed', invalidMessage: 'not sent over HTTP' };
    }
    return { isValid: true, payer: 'fake-agent' };
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settled.push({ payload, requirements });
    if (requirements.payTo === 'seller_settle_fail') {
      return { success: false, errorReason: 'fake_settle_failed', transaction: '', network: requirements.network };
    }
    this.counter += 1;
    return {
      success: true,
      transaction: `fake-${this.counter}`,
      network: requirements.network,
      amount: requirements.amount,
    };
  }
}

function inProcessFacilitator(facilitator: x402Facilitator): FacilitatorClient {
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async (): Promise<SupportedResponse> => {
      const supported = facilitator.getSupported();
      return {
        ...supported,
        kinds: supported.kinds.map((kind) => ({ ...kind, network: kind.network as Network }) satisfies SupportedKind),
      };
    },
  };
}

describe('x402 SDK plumbing with a fake paypal:sandbox scheme', () => {
  const fakeFacilitator = new FakeFacilitator();
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const facilitator = new x402Facilitator().register(NETWORK, fakeFacilitator);
    const resourceServer = new x402ResourceServer(inProcessFacilitator(facilitator)).register(
      'paypal:*',
      new FakeServer(),
    );
    await resourceServer.initialize();

    const app = express();
    app.use(
      paymentMiddleware(
        {
          'GET /fixed': {
            accepts: { scheme: SCHEME_ID, network: NETWORK, payTo: 'seller_test', price: '$0.01' },
          },
          'GET /override': {
            accepts: { scheme: SCHEME_ID, network: NETWORK, payTo: 'seller_test', price: '$0.02' },
          },
          'GET /verify-fail': {
            accepts: { scheme: SCHEME_ID, network: NETWORK, payTo: 'seller_verify_fail', price: '$0.01' },
          },
          'GET /settle-fail': {
            accepts: { scheme: SCHEME_ID, network: NETWORK, payTo: 'seller_settle_fail', price: '$0.01' },
          },
          'GET /handler-error': {
            accepts: { scheme: SCHEME_ID, network: NETWORK, payTo: 'seller_test', price: '$0.01' },
          },
          'GET /long-timeout': {
            accepts: {
              scheme: SCHEME_ID,
              network: NETWORK,
              payTo: 'seller_test',
              price: '$0.01',
              maxTimeoutSeconds: 600,
            },
          },
        },
        resourceServer,
      ),
    );
    app.get('/fixed', (_req, res) => {
      res.json({ data: 'fixed' });
    });
    app.get('/override', (_req, res) => {
      setSettlementOverrides(res, { amount: '1' });
      res.json({ data: 'override' });
    });
    app.get('/verify-fail', (_req, res) => {
      res.json({ data: 'never served' });
    });
    app.get('/settle-fail', (_req, res) => {
      res.json({ data: 'discarded' });
    });
    app.get('/handler-error', (_req, res) => {
      res.status(500).json({ error: 'boom' });
    });
    app.get('/long-timeout', (_req, res) => {
      res.json({ data: 'long' });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 402 with a decodable PAYMENT-REQUIRED listing the PayPal requirement', async () => {
    const res = await fetch(`${baseUrl}/fixed`);
    expect(res.status).toBe(402);
    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).toBeTruthy();
    const required = decodePaymentRequiredHeader(header ?? '');
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: SCHEME_ID,
      network: NETWORK,
      asset: 'USD',
      amount: '1',
      payTo: 'seller_test',
      maxTimeoutSeconds: 300,
    });
  });

  it('pays automatically through wrapFetchWithPayment and returns a decodable PAYMENT-RESPONSE', async () => {
    const payingFetch = wrapFetchWithPayment(fetch, new x402Client().register('paypal:*', new FakeClient()));
    const res = await payingFetch(`${baseUrl}/fixed`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'fixed' });
    const header = res.headers.get('PAYMENT-RESPONSE');
    expect(header).toBeTruthy();
    const settled = decodePaymentResponseHeader(header ?? '');
    expect(settled.success).toBe(true);
    expect(settled.transaction).toMatch(/^fake-\d+$/);
    expect(settled.network).toBe(NETWORK);
    expect(settled.amount).toBe('1');
  });

  it('passes a settlement override to the facilitator while accepted keeps the advertised maximum', async () => {
    const payingFetch = wrapFetchWithPayment(fetch, new x402Client().register('paypal:*', new FakeClient()));
    const before = fakeFacilitator.settled.length;
    const res = await payingFetch(`${baseUrl}/override`);
    expect(res.status).toBe(200);
    const call = fakeFacilitator.settled[before];
    expect(call).toBeDefined();
    expect(call?.requirements.amount).toBe('1');
    expect(call?.payload.accepted.amount).toBe('2');
  });

  it('surfaces a verify failure reason in the decoded PAYMENT-REQUIRED error field', async () => {
    const payingFetch = wrapFetchWithPayment(fetch, new x402Client().register('paypal:*', new FakeClient()));
    const res = await payingFetch(`${baseUrl}/verify-fail`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '');
    expect(required.error).toBe('fake_verify_failed');
  });

  it('discards handler output and surfaces a settle failure in PAYMENT-RESPONSE.errorReason', async () => {
    const payingFetch = wrapFetchWithPayment(fetch, new x402Client().register('paypal:*', new FakeClient()));
    const res = await payingFetch(`${baseUrl}/settle-fail`);
    expect(res.status).toBe(402);
    const body = await res.text();
    expect(body).not.toContain('discarded');
    const settled = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '');
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe('fake_settle_failed');
  });

  it('does not settle when the handler fails', async () => {
    const payingFetch = wrapFetchWithPayment(fetch, new x402Client().register('paypal:*', new FakeClient()));
    const before = fakeFacilitator.settled.length;
    const res = await payingFetch(`${baseUrl}/handler-error`);
    expect(res.status).toBe(500);
    expect(fakeFacilitator.settled.length).toBe(before);
  });

  it('lets the scheme clamp maxTimeoutSeconds in enhancePaymentRequirements', async () => {
    const res = await fetch(`${baseUrl}/long-timeout`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '');
    expect(required.accepts[0]?.maxTimeoutSeconds).toBe(300);
  });
});
