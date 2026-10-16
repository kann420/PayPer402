/** Test helpers: the seller app over an in-memory facilitator, and a paying client. Not part of the app. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer } from '@x402/core/server';
import {
  InMemoryAgentRegistry,
  InMemoryCommitmentLedger,
  PAYPAL_NETWORK_FAMILY,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchClientScheme,
  PayPalBatchFacilitatorScheme,
  PayPalBatchServerScheme,
  generateAgentKey,
  localFacilitatorClient,
  type AgentKey,
} from '@payper402/scheme-paypal';
import type { SellerAi } from './ai';
import { createSellerApp } from './app';

export const PAY_TO = 'sel_test';
/** 2026-10-16T12:34:56.789Z. */
export const NOW_MS = Date.UTC(2026, 9, 16, 12, 34, 56, 789);

/** A seller AI that answers deterministically, or fails when told to. */
export class FakeSellerAi implements SellerAi {
  fail = false;
  readonly calls: { method: 'summarize' | 'translate'; input: unknown }[] = [];

  async summarize(input: { title: string; text: string; maxWords: number }): Promise<string> {
    this.calls.push({ method: 'summarize', input });
    if (this.fail) throw new Error('model down');
    return `Summary of ${input.title} in ${input.maxWords} words or fewer.`;
  }

  async translate(input: { text: string; targetLanguage: string }): Promise<string> {
    this.calls.push({ method: 'translate', input });
    if (this.fail) throw new Error('model down');
    return `[${input.targetLanguage}] ${input.text}`;
  }
}

export interface TestSeller {
  url: string;
  server: Server;
  ledger: InMemoryCommitmentLedger;
  ai: FakeSellerAi;
  key: AgentKey;
  close(): Promise<void>;
}

export async function startTestSeller(options: { now?: () => number } = {}): Promise<TestSeller> {
  const key = generateAgentKey();
  const registry = new InMemoryAgentRegistry()
    .addOperator({ operatorId: 'op_test', walletStatus: 'active', caps: { perCall: 100, daily: 10_000, unsettled: 10_000 } })
    .addAgent({ agentId: 'agt_test', kid: key.kid, publicKeyX: key.publicKeyX, operatorId: 'op_test', status: 'active' });
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
  const ai = new FakeSellerAi();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    createSellerApp({ payTo: PAY_TO, sellerName: 'Acme Data', publicUrl: url, resourceServer, ai, now: options.now ?? (() => NOW_MS) }),
  );
  return {
    url,
    server,
    ledger,
    ai,
    key,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface CallOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** A raw body string, sent as JSON. */
  rawBody?: string;
}

function request(url: string, method: string, options: CallOptions, headers: Record<string, string> = {}) {
  const target = new URL(url);
  for (const [name, value] of Object.entries(options.query ?? {})) target.searchParams.set(name, value);
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return fetch(target, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

/** Unpaid request. */
export function call(seller: TestSeller, method: string, path: string, options: CallOptions = {}) {
  return request(`${seller.url}${path}`, method, options);
}

/** The x402 flow by hand: probe, sign, pay with the same request. Returns the paid response. */
export async function paidCall(seller: TestSeller, method: string, path: string, options: CallOptions = {}) {
  const http = new x402HTTPClient(
    new x402Client().register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: seller.key.privateKey })),
  );
  const probe = await request(`${seller.url}${path}`, method, options);
  if (probe.status !== 402) throw new Error(`Expected 402, got ${probe.status}`);
  const required = http.getPaymentRequiredResponse((name) => probe.headers.get(name));
  const payload = await http.createPaymentPayload(required);
  return request(`${seller.url}${path}`, method, options, http.encodePaymentSignatureHeader(payload));
}
