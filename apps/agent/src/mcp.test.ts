import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from './mcp';
import { openSession } from './session';
import { TOOL_DESCRIPTIONS } from './tools';
import { startDemoEnv, type Env } from './test-support';

describe('MCP server', () => {
  let env: Env;
  let client: Client;
  let logged: string[];
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    env = await startDemoEnv();
    const session = await openSession({ sellerUrl: env.url, privateKey: env.key.privateKey, budgetCents: 100, maxPerCallCents: 10 });
    logged = [];
    stdout = vi.spyOn(process.stdout, 'write');
    const server = createMcpServer(session, { log: (line) => logged.push(line) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    stdout.mockRestore();
    await env.close();
  });

  const json = (result: Awaited<ReturnType<Client['callTool']>>) => {
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0]?.text ?? 'null') as Record<string, unknown>;
  };

  it('lists exactly list_services, call_service and get_budget, with descriptions, the enum and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_services', 'call_service', 'get_budget']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['list_services']).toMatchObject({ description: TOOL_DESCRIPTIONS.list_services, annotations: { readOnlyHint: true } });
    expect(byName['get_budget']).toMatchObject({ description: TOOL_DESCRIPTIONS.get_budget, annotations: { readOnlyHint: true } });
    expect(byName['call_service']).toMatchObject({
      description: TOOL_DESCRIPTIONS.call_service,
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          service_id: { type: 'string', enum: ['quote', 'summarize', 'translate', 'premium_news'] },
          reason: { type: 'string', minLength: 1, maxLength: 300 },
        },
        required: ['service_id', 'params', 'reason'],
        additionalProperties: false,
      },
    });
  });

  it('call_service pays, get_budget reflects it, and the budget persists across calls', async () => {
    const first = await client.callTool({ name: 'call_service', arguments: { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Price' } });
    expect(first.isError).toBeFalsy();
    expect(json(first)).toMatchObject({ ok: true, service: 'quote', paidCents: 2, budget: { spentCents: 2, remainingCents: 98 } });
    expect(json(first)['commitmentId']).toBe(env.ledger.all()[0]?.id);
    await client.callTool({ name: 'call_service', arguments: { service_id: 'translate', params: { text: 'Hi', targetLanguage: 'vi' }, reason: 'Translate' } });
    const budget = json(await client.callTool({ name: 'get_budget', arguments: {} }));
    expect(budget).toEqual({ budgetCents: 100, spentCents: 3, uncertainCents: 0, remainingCents: 97, maxPerCallCents: 10, paidCalls: 2 });
    const listed = json(await client.callTool({ name: 'list_services', arguments: {} }));
    expect(listed['budget']).toEqual({ budgetCents: 100, spentCents: 3, remainingCents: 97, maxPerCallCents: 10 });
  });

  it('an over-limit service returns isError with refused', async () => {
    const result = await client.callTool({ name: 'call_service', arguments: { service_id: 'premium_news', params: { topic: 'coffee' }, reason: 'Full' } });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ ok: false, error: 'refused', code: 'over_per_call_limit' });
  });

  it('invalid params return isError with invalid_params', async () => {
    const result = await client.callTool({ name: 'call_service', arguments: { service_id: 'quote', params: { ticker: 'KC' }, reason: 'Price' } });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ ok: false, error: 'invalid_params' });
  });

  it('logs events through the injected logger and writes nothing to stdout', async () => {
    await client.callTool({ name: 'call_service', arguments: { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Price' } });
    await client.callTool({ name: 'get_budget', arguments: {} });
    expect(logged).toEqual([
      expect.stringMatching(/^\[402\] call_1/),
      expect.stringMatching(/^\[decide\] call_1/),
      expect.stringMatching(/^\[paid\] call_1/),
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });
});
