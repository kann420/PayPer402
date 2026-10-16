/**
 * Phase 3 plumbing checks (build spec Milestone 1), kept as tests: the manual x402 client flow on a
 * POST route, client policies and spend controls, the Anthropic tool runner request shape, and the
 * MCP SDK. They guard the SDK behaviour the agent relies on.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server as McpLowLevelServer } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentOption } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import {
  InMemoryAgentRegistry,
  InMemoryCommitmentLedger,
  PAYPAL_NETWORK_FAMILY,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchClientScheme,
  PayPalBatchFacilitatorScheme,
  PayPalBatchServerScheme,
  SCHEME,
  generateAgentKey,
  localFacilitatorClient,
} from '@payper402/scheme-paypal';
import { z } from 'zod';
import { fakeAnthropic, message, text, toolUse } from './test-support';

const SELLER = 'sel_plumbing';

describe('x402 manual flow on a POST route', () => {
  const key = generateAgentKey();
  const ledger = new InMemoryCommitmentLedger();
  let server: Server;
  let baseUrl: string;
  const seen: unknown[] = [];

  beforeAll(async () => {
    const registry = new InMemoryAgentRegistry()
      .addOperator({ operatorId: 'op_p', walletStatus: 'active', caps: { perCall: 25, daily: 1000, unsettled: 500 } })
      .addAgent({ agentId: 'agt_p', kid: key.kid, publicKeyX: key.publicKeyX, operatorId: 'op_p', status: 'active' });
    const facilitator = new x402Facilitator().register(
      PAYPAL_SANDBOX_NETWORK,
      new PayPalBatchFacilitatorScheme({ agents: registry, ledger }),
    );
    const resourceServer = new x402ResourceServer(localFacilitatorClient(facilitator)).register(
      PAYPAL_NETWORK_FAMILY,
      new PayPalBatchServerScheme(),
    );
    await resourceServer.initialize();
    const accepts: PaymentOption = { scheme: SCHEME, network: PAYPAL_SANDBOX_NETWORK, payTo: SELLER, price: { asset: 'USD', amount: '3' } };
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.use(paymentMiddleware({ 'POST /echo': { accepts, description: 'Echo', mimeType: 'application/json' } }, resourceServer));
    app.post('/echo', (req, res) => {
      seen.push(req.body);
      res.json({ echo: req.body as unknown });
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ hello: 'world' }),
    });

  it('402, decode, sign, paid POST with the same body, settle response with the ledger id', async () => {
    const http = new x402HTTPClient(
      new x402Client().register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: key.privateKey })),
    );
    const probe = await post();
    expect(probe.status).toBe(402);
    const required = http.getPaymentRequiredResponse((name) => probe.headers.get(name));
    expect(required.accepts[0]).toMatchObject({ amount: '3', payTo: SELLER, asset: 'USD' });
    const payload = await http.createPaymentPayload(required);
    const paid = await post(http.encodePaymentSignatureHeader(payload));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ echo: { hello: 'world' } });
    expect(seen).toEqual([{ hello: 'world' }]);
    const settled = http.getPaymentSettleResponse((name) => paid.headers.get(name));
    expect(settled.success).toBe(true);
    expect(settled.amount).toBe('3');
    expect(ledger.all()).toHaveLength(1);
    expect(settled.transaction).toBe(ledger.all()[0]?.id);
  });

  it('a policy that filters out every requirement makes createPaymentPayload throw', async () => {
    const client = new x402Client()
      .register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: key.privateKey }))
      .registerPolicy(() => []);
    const http = new x402HTTPClient(client);
    const probe = await post();
    const required = http.getPaymentRequiredResponse((name) => probe.headers.get(name));
    await expect(http.createPaymentPayload(required)).rejects.toThrow(
      'All payment requirements were filtered out by policies for x402 version: 2',
    );
  });

  it('a spend control of $0.02 rejects a 3-cent requirement; $0.03 accepts it', async () => {
    const client = new x402Client().register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: key.privateKey }));
    client.setSpendControls({ maxAmountPerPayment: '$0.02' });
    const http = new x402HTTPClient(client);
    const probe = await post();
    const required = http.getPaymentRequiredResponse((name) => probe.headers.get(name));
    await expect(http.createPaymentPayload(required)).rejects.toThrow(
      /All payment requirements were rejected by spendControls\.maxAmountPerPayment \(\$0\.02/,
    );
    client.setSpendControls({ maxAmountPerPayment: '$0.03' });
    await expect(http.createPaymentPayload(required)).resolves.toMatchObject({ accepted: { amount: '3' } });
  });
});

/** A JSON Schema built like `call_service`'s, written by hand (Milestone 1 check 5). */
const CALL_SCHEMA = {
  type: 'object',
  properties: {
    service_id: { type: 'string', enum: ['quote', 'summarize'], description: 'Catalog id' },
    reason: { type: 'string', minLength: 1, maxLength: 300, description: 'Why' },
    max_words: { type: 'integer', minimum: 30, maximum: 300, description: 'Words' },
  },
  required: ['service_id', 'reason'],
  additionalProperties: false,
} as const;

describe('zod copies seen by the SDKs', () => {
  it('records which zod each SDK resolves', () => {
    const here = createRequire(import.meta.url);
    const fromSdk = createRequire(here.resolve('@anthropic-ai/sdk'));
    const fromMcp = createRequire(here.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
    const norm = (p: string) => p.replace(/\\/g, '/');
    // Ours is the app's own zod 4; both SDKs are hoisted and resolve the root zod 3.25 copy.
    expect(norm(here.resolve('zod'))).toContain('/apps/agent/node_modules/zod/');
    expect(norm(fromSdk.resolve('zod/v4'))).not.toContain('/apps/agent/');
    expect(norm(fromMcp.resolve('zod'))).not.toContain('/apps/agent/');
  });

  it('betaZodTool loses descriptions, lengths and integer bounds on our zod 4 schemas (why we hand-write schemas)', () => {
    const schema = z.strictObject({
      reason: z.string().min(1).max(300).describe('Why'),
      max_words: z.number().int().min(30).max(300),
    });
    // The SDK's zod/v4 copy is a different module; the type does not accept ours either.
    const build = betaZodTool as unknown as (o: { name: string; description: string; inputSchema: unknown; run: () => string }) => {
      input_schema: Record<string, unknown>;
    };
    const tool = build({ name: 't', description: 'd', inputSchema: schema, run: () => '' });
    const props = tool.input_schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['reason']).toEqual({ type: 'string' });
    expect(props['max_words']).toEqual({ type: 'number' });
  });

  it('McpServer.registerTool loses the same detail on our zod 4 schemas (why the MCP server is the low-level Server)', async () => {
    const shape = {
      reason: z.string().min(1).max(300).describe('Why'),
      max_words: z.number().int().min(30).max(300).describe('Words'),
    };
    const server = new McpServer({ name: 'plumbing', version: '0.0.0' });
    // The SDK's zod copy is a different module; its types reject our shape too (build spec Findings, M1).
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: { description: string; inputSchema: unknown },
      cb: () => { content: { type: 'text'; text: string }[] },
    ) => void;
    register('t', { description: 'd', inputSchema: shape }, () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    const props = (await client.listTools()).tools[0]?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props['reason']).toEqual({ type: 'string' });
    expect(props['max_words']).toEqual({ type: 'number' });
    await client.close();
  });
});

describe('Anthropic tool runner request shape', () => {
  it('sends every §6.1 parameter, both betas, strict and the hand-written schema; run gets the parsed input', async () => {
    const fake = fakeAnthropic([
      message([toolUse('call_service', { service_id: 'quote', reason: 'needed' })]),
      message([text('done')], 'end_turn'),
    ]);
    const received: unknown[] = [];
    const callTool = betaTool({
      name: 'call_service',
      description: 'Call one paid service.',
      inputSchema: CALL_SCHEMA,
      run: (input) => {
        received.push(input);
        return 'ok';
      },
    });
    const budgetTool = {
      ...betaTool({
        name: 'get_budget',
        description: 'Show the budget.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: () => '{}',
      }),
      strict: true,
    };
    const runner = fake.client.beta.messages.toolRunner({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: 'medium' },
      betas: ['thinking-display-updates-2026-08-18', 'server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: 'system prompt',
      tools: [callTool, budgetTool],
      messages: [{ role: 'user', content: 'Task: x' }],
    });
    const messages = [];
    for await (const m of runner) messages.push(m);
    expect(messages).toHaveLength(2);
    expect(received).toEqual([{ service_id: 'quote', reason: 'needed' }]);
    expect(fake.requests).toHaveLength(2);
    const first = fake.requests[0];
    expect(first?.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: 'system prompt',
    });
    expect(first?.body).not.toHaveProperty('betas');
    expect(first?.body).not.toHaveProperty('tool_choice');
    expect(first?.body).not.toHaveProperty('max_iterations');
    expect(first?.headers['anthropic-beta']?.split(',').map((s) => s.trim())).toEqual(
      expect.arrayContaining(['thinking-display-updates-2026-08-18', 'server-side-fallback-2026-07-01']),
    );
    const tools = first?.body['tools'] as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: 'custom', name: 'call_service', description: 'Call one paid service.', input_schema: CALL_SCHEMA });
    expect(tools[1]).toMatchObject({ name: 'get_budget', strict: true, input_schema: { additionalProperties: false } });
  });
});

describe('MCP SDK low-level server with hand-written schemas', () => {
  it('lists the exact schema and calls the tool', async () => {
    const server = new McpLowLevelServer({ name: 'plumbing', version: '0.0.0' }, { capabilities: { tools: {} } });
    const calls: unknown[] = [];
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'call_service', description: 'Call one paid service.', inputSchema: CALL_SCHEMA }],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      calls.push(request.params.arguments);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools[0]?.inputSchema).toEqual(CALL_SCHEMA);
    const result = await client.callTool({ name: 'call_service', arguments: { service_id: 'quote', reason: 'r' } });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toEqual([{ service_id: 'quote', reason: 'r' }]);
    await client.close();
  });
});
