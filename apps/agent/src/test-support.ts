/** Test helpers: a scripted Anthropic transport and message builders. Not part of the library. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express, type RequestHandler } from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentOption, RouteConfig } from '@x402/core/http';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import {
  InMemoryAgentRegistry,
  InMemoryCommitmentLedger,
  PAYPAL_NETWORK_FAMILY,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchFacilitatorScheme,
  PayPalBatchServerScheme,
  SCHEME,
  generateAgentKey,
  localFacilitatorClient,
  type AgentKey,
  type Caps,
} from '@payper402/scheme-paypal';
import { SERVICES, createSellerApp, type SellerAi, type ServiceDef } from '@payper402/demo-seller';
import Anthropic from '@anthropic-ai/sdk';

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** One scripted answer: a message body, or an HTTP error with an API error body. */
export type ScriptedReply =
  | { message: Record<string, unknown> }
  | { status: number; error: { type: string; message: string } };

let counter = 0;

/** A Messages API response with the given content blocks. */
export function message(content: Record<string, unknown>[], stopReason = 'tool_use'): ScriptedReply {
  counter += 1;
  return {
    message: {
      id: `msg_test_${counter}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

export const text = (value: string) => ({ type: 'text', text: value });
export const thinking = (value: string) => ({ type: 'thinking', thinking: value, signature: 'sig_test' });
export function toolUse(name: string, input: Record<string, unknown>, id?: string) {
  counter += 1;
  return { type: 'tool_use', id: id ?? `toolu_test_${counter}`, name, input };
}

export interface FakeAnthropic {
  client: Anthropic;
  requests: RecordedRequest[];
}

/**
 * A `fetch` for the Anthropic SDK that answers from `script`, in order, and records each request.
 * An exhausted script answers HTTP 500. It never reaches the network.
 */
export function scriptedAnthropicFetch(script: ScriptedReply[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = [...script];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    requests.push({ url: String(input instanceof Request ? input.url : input), headers, body: JSON.parse(raw) as Record<string, unknown> });
    const reply = queue.shift();
    if (!reply) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'script exhausted' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ('message' in reply) {
      return new Response(JSON.stringify(reply.message), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ type: 'error', error: reply.error }), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn as typeof fetch, requests };
}

/**
 * An `Anthropic` client whose transport answers from `script`, in order. It has an explicit test
 * key and no retries, so it never resolves real credentials or reaches the network.
 */
export function fakeAnthropic(script: ScriptedReply[]): FakeAnthropic {
  const { fetch, requests } = scriptedAnthropicFetch(script);
  const client = new Anthropic({ apiKey: 'sk-ant-test-not-a-key', fetch, maxRetries: 0 });
  return { client, requests };
}

/* ---------------------------------------------------------------------------------------------
 * Seller environments for the payment core tests: the real demo seller app (or a custom test
 * seller) over an in-memory facilitator, with an optional wrapper around the facilitator client.
 * ------------------------------------------------------------------------------------------- */

export const DEMO_PAY_TO = 'sel_demo';
export const OPERATOR = 'op_test';

/** A seller AI that answers deterministically, or fails when told to. */
export class FakeSellerAi implements SellerAi {
  fail = false;
  async summarize(input: { title: string; maxWords: number }): Promise<string> {
    if (this.fail) throw new Error('model down');
    return `Summary of ${input.title}.`;
  }
  async translate(input: { text: string; targetLanguage: string }): Promise<string> {
    if (this.fail) throw new Error('model down');
    return `[${input.targetLanguage}] ${input.text}`;
  }
}

export interface Env {
  url: string;
  key: AgentKey;
  registry: InMemoryAgentRegistry;
  ledger: InMemoryCommitmentLedger;
  ai: FakeSellerAi;
  close(): Promise<void>;
}

export interface EnvOptions {
  caps?: Caps;
  /** Wraps the in-process facilitator client, to script verify and settle answers. */
  wrap?: (client: FacilitatorClient) => FacilitatorClient;
}

async function baseEnv(options: EnvOptions) {
  const key = generateAgentKey();
  const registry = new InMemoryAgentRegistry()
    .addOperator({ operatorId: OPERATOR, walletStatus: 'active', caps: options.caps ?? { perCall: 100, daily: 10_000, unsettled: 10_000 } })
    .addAgent({ agentId: 'agt_test', kid: key.kid, publicKeyX: key.publicKeyX, operatorId: OPERATOR, status: 'active' });
  const ledger = new InMemoryCommitmentLedger();
  const facilitator = new x402Facilitator().register(PAYPAL_SANDBOX_NETWORK, new PayPalBatchFacilitatorScheme({ agents: registry, ledger }));
  const local = localFacilitatorClient(facilitator);
  const resourceServer = new x402ResourceServer(options.wrap ? options.wrap(local) : local).register(
    PAYPAL_NETWORK_FAMILY,
    new PayPalBatchServerScheme(),
  );
  await resourceServer.initialize();
  return { key, registry, ledger, resourceServer };
}

async function listen(build: (url: string) => Express): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', build(url));
  return { url, server };
}

function closer(server: Server) {
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

/** The real demo seller app. */
export async function startDemoEnv(options: EnvOptions = {}): Promise<Env> {
  const base = await baseEnv(options);
  const ai = new FakeSellerAi();
  const { url, server } = await listen((publicUrl) =>
    createSellerApp({ payTo: DEMO_PAY_TO, sellerName: 'Acme Data', publicUrl, resourceServer: base.resourceServer, ai }),
  );
  return { url, key: base.key, registry: base.registry, ledger: base.ledger, ai, close: closer(server) };
}

export interface CustomRoute {
  service: ServiceDef;
  /** Overrides the route's payment option (the 402), while the catalog keeps `service`. */
  accepts?: Partial<PaymentOption>;
  handler: RequestHandler;
}

/** A test seller with its own catalog and routes. */
export async function startCustomEnv(routes: CustomRoute[], options: EnvOptions = {}): Promise<Env> {
  const base = await baseEnv(options);
  const config: Record<string, RouteConfig> = {};
  for (const route of routes) {
    const accepts: PaymentOption = {
      scheme: SCHEME,
      network: PAYPAL_SANDBOX_NETWORK,
      payTo: DEMO_PAY_TO,
      price: { asset: 'USD', amount: String(route.service.priceCents) },
      ...route.accepts,
    };
    config[`${route.service.method} ${route.service.path}`] = { accepts };
  }
  const { url, server } = await listen(() => {
    const app = express();
    app.use(express.json());
    app.get('/v1/catalog', (_req, res) => {
      res.json({
        seller: { name: 'Test Seller', payTo: DEMO_PAY_TO },
        scheme: SCHEME,
        network: PAYPAL_SANDBOX_NETWORK,
        asset: 'USD',
        services: routes.map((r) => r.service),
      });
    });
    app.use(paymentMiddleware(config, base.resourceServer));
    for (const route of routes) {
      if (route.service.method === 'GET') app.get(route.service.path, route.handler);
      else app.post(route.service.path, route.handler);
    }
    return app;
  });
  return { url, key: base.key, registry: base.registry, ledger: base.ledger, ai: new FakeSellerAi(), close: closer(server) };
}

export function demoService(id: string): ServiceDef {
  const service = SERVICES.find((s) => s.id === id);
  if (!service) throw new Error(`no service ${id}`);
  return { ...service, params: structuredClone(service.params), required: [...service.required] };
}

/** A `fetch` that counts requests (excluding the catalog) and can rewrite responses. */
export function fetchSpy(rewrite?: (res: Response, init: RequestInit | undefined, url: string) => Response | Promise<Response>) {
  const calls: { url: string; paid: boolean }[] = [];
  const spy = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const paid = new Headers(init?.headers).has('PAYMENT-SIGNATURE');
    if (!url.endsWith('/v1/catalog')) calls.push({ url, paid });
    const res = await fetch(input, init);
    return rewrite ? rewrite(res, init, url) : res;
  };
  return { fetch: spy as typeof fetch, calls };
}

/** Copies a response with some headers removed or replaced. */
export async function withHeaders(res: Response, change: (headers: Headers) => void): Promise<Response> {
  const headers = new Headers(res.headers);
  change(headers);
  return new Response(await res.arrayBuffer(), { status: res.status, headers });
}
