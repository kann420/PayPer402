import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportPrivateKeyRaw, generateAgentKey } from '@payper402/scheme-paypal';
import { runCli, type CliDeps, type CliIo } from './cli';
import { configPath, readCliConfig, writeCliConfig, type CliConfig } from './cli-config';
import { ConfigError, DEFAULT_SELLER_URL, loadAgentConfig } from './config';
import { getAgentStatus, redeemClaim, type ApiResult } from './facilitator-api';
import { startMcpStdio } from './mcp';
import { formatStatus } from './status-format';

export const DEFAULT_API_URL = 'http://localhost:4020';

export interface Payper402Deps extends CliDeps {
  /** Unix seconds, for the config's `createdAt` and the status signature. Defaults to the system clock. */
  now?: () => number;
  /** Selects the Windows `claude mcp add` line. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** A mistake in the command line: the message, then the usage, both on stderr (operator-cli.md §6.1). */
class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** An expected failure: one `Error:` line on stderr and exit 1. */
class CommandError extends Error {
  override readonly name = 'CommandError';
}

const usage = (env: Record<string, string | undefined>) =>
  [
    'payper402 - pay-per-call for AI agents, settled with PayPal',
    '',
    'Usage:',
    '  payper402 onboard --claim <code> [--api <url>] [--seller <url>] [--force]',
    '                              Connect this machine as an agent, with a claim code from the web app',
    '  payper402 status [--json]   Show what this agent may spend now, and why it is blocked if it is',
    '  payper402 mcp [--budget <usd>] [--max-per-call <usd>]',
    '                              Start the MCP server over stdio',
    '  payper402 run [--budget <usd>] [--max-per-call <usd>] [--no-spend-check] "<task>"',
    '                              Run the Claude agent on a task',
    '  payper402 version           Print the version',
    '  payper402 help              Show this message',
    '',
    `Config: ${configPath(env)}`,
  ];

/** The `apps/agent` package version. */
async function packageVersion(): Promise<string> {
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : 'unknown';
}

/** Runs a strict `parseArgs`; its errors become usage errors. */
function strictly<R>(parse: () => R): R {
  try {
    return parse();
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : 'Invalid arguments');
  }
}

/** An absolute `http:` or `https:` URL without trailing slashes, or a `CommandError`. */
function httpUrl(flag: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return value.replace(/\/+$/, '');
  } catch {
    // Falls through to the error below.
  }
  throw new CommandError(`${flag} must be an http(s) URL`);
}

/** The message of a failed facilitator call (operator-cli.md §6.3), shared by `onboard` and `status`. */
function failureMessage(result: Extract<ApiResult<unknown>, { ok: false }>, api: string): string {
  if (result.kind === 'network') return `Could not reach PayPer402 at ${api}.`;
  if (result.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return `PayPer402 answered ${result.status}. Try again.`;
}

const NOT_CONNECTED = 'This machine is not connected. Run payper402 onboard --claim <code> first.';

/** The config file, or a `CommandError` that says what to do. */
async function requireConfig(env: Record<string, string | undefined>) {
  const read = await readCliConfig(env);
  if (read.ok) return read;
  if (read.reason === 'missing') throw new CommandError(NOT_CONNECTED);
  throw new CommandError(`The config at ${configPath(env)} is invalid. Run payper402 onboard --force.`);
}

async function onboard(args: string[], env: Record<string, string | undefined>, io: CliIo, deps: Payper402Deps): Promise<number> {
  const { values } = strictly(() =>
    parseArgs({
      args,
      options: { claim: { type: 'string' }, api: { type: 'string' }, seller: { type: 'string' }, force: { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    }),
  );
  const code = values.claim?.trim();
  if (code === undefined || code === '') throw new UsageError('--claim <code> is required');
  const api = httpUrl('--api', values.api ?? DEFAULT_API_URL);
  const seller = values.seller === undefined ? undefined : httpUrl('--seller', values.seller);

  if (values.force !== true) {
    const existing = await readCliConfig(env);
    if (existing.ok) {
      throw new CommandError(
        `This machine is already connected as ${existing.config.agent.name}. Use --force to replace it; the old key is deleted.`,
      );
    }
    if (existing.reason === 'invalid') {
      throw new CommandError(`This machine already has a config at ${configPath(env)}. Use --force to replace it; the old key is deleted.`);
    }
  }

  // The key stays in memory until the config is written; any error below discards it.
  const key = generateAgentKey();
  const result = await redeemClaim({ api, code, publicKeyX: key.publicKeyX, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  if (!result.ok) {
    if (result.kind === 'http') {
      if (result.status === 404 && result.error === 'claim_not_found') throw new CommandError('That claim code is not valid. Check it, or create a new one in the web app.');
      if (result.status === 400 && result.error === 'validation_failed' && result.issuePaths.includes('code')) {
        throw new CommandError('That claim code is not valid. Check it, or create a new one in the web app.');
      }
      if (result.status === 409 && result.error === 'claim_used') throw new CommandError('That claim code was already used. Create a new one in the web app.');
      if (result.status === 410 && result.error === 'claim_expired') throw new CommandError('That claim code has expired. Create a new one in the web app.');
    }
    throw new CommandError(failureMessage(result, api));
  }
  const { agent, operator } = result.body;
  if (agent.kid !== key.kid) throw new CommandError('PayPer402 created an agent for a different key. Create a new claim code and try again.');

  const config: CliConfig = {
    version: 1,
    facilitatorUrl: api,
    sellerUrl: seller ?? (result.body.sellerUrl === null ? DEFAULT_SELLER_URL : httpUrl('sellerUrl', result.body.sellerUrl)),
    operatorName: operator.name,
    agent: { id: agent.id, name: agent.name, kid: agent.kid, keyFingerprint: agent.keyFingerprint },
    privateKey: exportPrivateKeyRaw(key.privateKey),
    createdAt: (deps.now ?? (() => Math.floor(Date.now() / 1000)))(),
  };
  try {
    await writeCliConfig(env, config);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? 'write failed';
    throw new CommandError(
      `The agent ${agent.name} was created, but the config could not be saved: ${reason}. Pause it in the web app and create a new claim code.`,
    );
  }
  const windows = (deps.platform ?? process.platform) === 'win32';
  io.out(`Connected as ${agent.name} (${agent.keyFingerprint}) for ${operator.name}.`);
  io.out(`Your private key stays on this machine: ${configPath(env)}`);
  io.out('');
  io.out('Next:');
  io.out('  payper402 status');
  io.out(`  claude mcp add payper402 -- ${windows ? 'cmd /c ' : ''}payper402 mcp`);
  return 0;
}

async function status(args: string[], env: Record<string, string | undefined>, io: CliIo, deps: Payper402Deps): Promise<number> {
  const { values } = strictly(() => parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: false, strict: true }));
  const { config, privateKey } = await requireConfig(env);
  const result = await getAgentStatus({
    api: config.facilitatorUrl,
    privateKey,
    kid: config.agent.kid,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (!result.ok) {
    if (result.kind === 'http' && result.status === 401) {
      throw new CommandError("PayPer402 does not recognise this agent's key. Create a new claim code and run payper402 onboard --force.");
    }
    throw new CommandError(failureMessage(result, config.facilitatorUrl));
  }
  if (values.json === true) {
    io.out(JSON.stringify(result.body, null, 2));
    return 0;
  }
  for (const line of formatStatus(result.body, config.sellerUrl)) io.out(line);
  return 0;
}

const BUDGET_FLAGS = { budget: { type: 'string' }, 'max-per-call': { type: 'string' } } as const;

/** The agent configuration of `mcp` and `run`: the environment, with the key and seller from the config file. */
function agentEnv(env: Record<string, string | undefined>, config: CliConfig): Record<string, string | undefined> {
  return { ...env, AGENT_PRIVATE_KEY: config.privateKey, SELLER_URL: config.sellerUrl };
}

async function mcp(args: string[], env: Record<string, string | undefined>): Promise<number> {
  strictly(() => parseArgs({ args, options: BUDGET_FLAGS, allowPositionals: false, strict: true }));
  const { config } = await requireConfig(env);
  let agentConfig;
  try {
    agentConfig = loadAgentConfig(agentEnv(env, config), args);
  } catch (err) {
    throw new CommandError(err instanceof ConfigError ? err.message : 'Invalid configuration');
  }
  // Nothing goes to stdout here: it carries the MCP protocol. Events and the ready line go to stderr.
  const started = await startMcpStdio(agentConfig);
  if (!started.ok) throw new CommandError(started.message);
  return 0;
}

async function run(args: string[], env: Record<string, string | undefined>, io: CliIo, deps: Payper402Deps): Promise<number> {
  strictly(() => parseArgs({ args, options: { ...BUDGET_FLAGS, 'no-spend-check': { type: 'boolean' } }, allowPositionals: true, strict: true }));
  const { config } = await requireConfig(env);
  return runCli(args, agentEnv(env, config), io, deps);
}

/**
 * The `payper402` command (operator-cli.md §6). Reads only `env`, never `process.env`, and returns
 * the exit code. `onboard`, `status` and `help` write through `io`; `mcp` writes only to stderr.
 */
export async function runPayper402(argv: string[], env: Record<string, string | undefined>, io: CliIo, deps: Payper402Deps = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        for (const line of usage(env)) io.out(line);
        return 0;
      case 'version':
      case '--version':
      case '-v':
        io.out(await packageVersion());
        return 0;
      case 'onboard':
        return await onboard(rest, env, io, deps);
      case 'status':
        return await status(rest, env, io, deps);
      case 'mcp':
        return await mcp(rest, env);
      case 'run':
        return await run(rest, env, io, deps);
      default:
        throw new UsageError(`Unknown command '${command}'`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`Error: ${err.message}`);
      for (const line of usage(env)) io.err(line);
      return 1;
    }
    if (err instanceof CommandError) {
      io.err(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/** The process entry: real stdio, the real environment, and Ctrl-C aborting a `run`. */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const abort = new AbortController();
  if (argv[0] === 'run') process.once('SIGINT', () => abort.abort());
  try {
    process.exitCode = await runPayper402(
      argv,
      process.env,
      { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
      { signal: abort.signal },
    );
  } catch {
    process.stderr.write('Error: payper402 failed unexpectedly\n');
    process.exitCode = 1;
  }
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('/src/payper402.ts')) void main();
