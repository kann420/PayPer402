import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CatalogError } from './catalog';
import { ConfigError, loadAgentConfig, type AgentConfig } from './config';
import { formatEvent } from './format';
import { openSession, type AgentSession } from './session';
import { createToolCore } from './tools';

export const MCP_SERVER_NAME = 'payper402';
export const MCP_SERVER_VERSION = '0.1.1';

export interface McpServerOptions {
  /** Where events are logged, one line each. Defaults to stderr: stdout carries only the protocol. */
  log?: (line: string) => void;
}

const stderrLog = (line: string) => {
  process.stderr.write(`${line}\n`);
};

/**
 * An MCP server over a session's tool core (design spec §8): `list_services`, `call_service` and
 * `get_budget`. It is the low-level `Server` with hand-written schemas (build spec Findings, M1).
 */
export function createMcpServer(session: AgentSession, options: McpServerOptions = {}): Server {
  const log = options.log ?? stderrLog;
  const tools = createToolCore(session);
  let logged = session.events.length;
  const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(
      (tool): Tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema },
        annotations: { ...tool.annotations },
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown_tool', message: 'There is no such tool' }) }], isError: true };
    }
    const output = await tool.run(request.params.arguments ?? {});
    for (const event of session.events.slice(logged)) log(formatEvent(event));
    logged = session.events.length;
    return { content: [{ type: 'text', text: output.text }], ...(output.isError ? { isError: true } : {}) };
  });

  return server;
}

/** The result of starting the stdio server: the running server, or the one-line reason it could not start. */
export type McpStart = { ok: true; server: Server; session: AgentSession } | { ok: false; message: string };

/**
 * The start-up steps shared by `npm run mcp` and `payper402 mcp` (design spec §8): opens the
 * session, connects the server to a transport (stdio unless a test passes one) and logs the ready
 * line. It writes nothing to stdout itself.
 */
export async function startMcpStdio(
  config: AgentConfig,
  log: (line: string) => void = stderrLog,
  transport: Transport = new StdioServerTransport(),
): Promise<McpStart> {
  let session: AgentSession;
  try {
    session = await openSession({
      sellerUrl: config.sellerUrl,
      privateKey: config.privateKey,
      budgetCents: config.budgetCents,
      maxPerCallCents: config.maxPerCallCents,
    });
  } catch (err) {
    return { ok: false, message: err instanceof CatalogError ? err.message : 'Could not open the session' };
  }
  const server = createMcpServer(session, { log });
  await server.connect(transport);
  log(`PayPer402 MCP server ready: ${session.catalog.seller.name}, ${session.catalog.services.length} services`);
  return { ok: true, server, session };
}

/** The stdio entry: the CLI's environment, with `AGENT_BUDGET` as the budget for the process. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadAgentConfig(process.env, []);
  } catch (err) {
    stderrLog(err instanceof ConfigError ? err.message : 'Invalid configuration');
    process.exitCode = 1;
    return;
  }
  const started = await startMcpStdio(config, stderrLog);
  if (!started.ok) {
    stderrLog(started.message);
    process.exitCode = 1;
  }
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('/src/mcp.ts')) {
  main().catch(() => {
    stderrLog('The MCP server failed unexpectedly');
    process.exitCode = 1;
  });
}
