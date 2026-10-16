/**
 * PayPer402 demo command (design spec §9): the whole story in one process. The facilitator, the demo
 * seller and the Claude agent run here against the real PayPal sandbox and the real Anthropic API.
 *
 *   npm run demo -- [--link] [--no-settle] [--no-spend-check] [--budget 1.00] ["<task>"]
 *
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, DATA_ENCRYPTION_KEY, API_KEY_PEPPER and Anthropic
 * credentials (root .env). Optional: DEMO_DATABASE_PATH (default <repo>/data/demo.db), PORT (4020),
 * SELLER_PORT (4021), PUBLIC_BASE_URL, ANTHROPIC_MODEL, AGENT_PRIVATE_KEY, LOG_LEVEL (default warn), TYPESAFE_API_KEY (enables the
 * decision layer; the task text is sent to TypeSafe).
 * Never prints API keys, the agent private key, vault ids or payment headers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import { SELLER_AI_TIMEOUT_MS, createClaudeSellerAi, startSeller, type RunningSeller } from '@payper402/demo-seller';
import { hashApiKey, issueApiKey } from '@payper402/facilitator/auth';
import { ConfigError, loadConfig, type Config } from '@payper402/facilitator/config';
import { createLogger, errorMessage } from '@payper402/facilitator/logger';
import { seed } from '@payper402/facilitator/seed';
import { startFacilitator, type RunningFacilitator } from '@payper402/facilitator/server';
import { exportPrivateKeyRaw, generateAgentKey, importPrivateKeyRaw, kidFromPublicKeyX, priceToCents, publicKeyX } from '@payper402/scheme-paypal';
import { DEFAULT_MODEL, runAgent } from '../src/agent';
import { DEFAULT_TASK, ConfigError as AgentConfigError, decisionLayerWant, parseAgentKey } from '../src/config';
import { DemoFail, checkLedger, ensureAgent, settleRun, settlementDecision, type Api } from '../src/demo-steps';
import { formatEvent, formatReport } from '../src/format';
import { createJevSpendCheck } from '../src/jev';
import { openSession } from '../src/session';
import { setupDecisionLayer, type DecisionLayerWant } from '../src/spend-check';
import { formatUsd } from '../src/tools';

const LINK_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const AGENT_NAME = 'research-bot';
const KEY_LABEL = 'demo-run';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Ctrl+C aborts the waits and the agent run, so the cleanup still runs. */
const interrupt = new AbortController();
const out = (line = '') => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => delay(ms, undefined, { signal: interrupt.signal });

interface Args {
  link: boolean;
  settle: boolean;
  budgetCents: number;
  task: string;
  decisionLayer: DecisionLayerWant;
}

function parseCommandLine(): Args {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { link: { type: 'boolean' }, 'no-settle': { type: 'boolean' }, 'no-spend-check': { type: 'boolean' }, budget: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new DemoFail(err instanceof Error ? err.message : 'Invalid arguments.');
  }
  let budgetCents: number;
  try {
    budgetCents = priceToCents(parsed.values.budget ?? '1.00');
  } catch {
    throw new DemoFail('--budget must be a dollar amount such as 1.00.');
  }
  if (budgetCents < 1) throw new DemoFail('--budget must be at least 0.01.');
  const task = parsed.positionals.join(' ').trim();
  return {
    link: parsed.values.link === true,
    settle: parsed.values['no-settle'] !== true,
    budgetCents,
    task: task === '' ? DEFAULT_TASK : task,
    decisionLayer: decisionLayerWant(process.env, parsed.values['no-spend-check'] === true),
  };
}

function buildConfig(): Config {
  const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'DATA_ENCRYPTION_KEY', 'API_KEY_PEPPER'].filter((name) => !process.env[name]?.trim());
  const anthropic = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE'].some((name) => process.env[name]?.trim());
  if (!anthropic) missing.push('ANTHROPIC_API_KEY (or another Anthropic credential)');
  if (missing.length > 0) {
    throw new DemoFail(
      `Missing required environment variables: ${missing.join(', ')}.\n` +
        'Set them in the root .env (see .env.example). DATA_ENCRYPTION_KEY and API_KEY_PEPPER must stay the same between runs, ' +
        'because the demo database is persistent.',
    );
  }
  const port = process.env['PORT']?.trim() || '4020';
  const databasePath = path.resolve(process.env['DEMO_DATABASE_PATH']?.trim() || path.join(REPO_ROOT, 'data', 'demo.db'));
  mkdirSync(path.dirname(databasePath), { recursive: true });
  try {
    return loadConfig({
      ...process.env,
      PORT: port,
      PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL']?.trim() || `http://localhost:${port}`,
      DATABASE_PATH: databasePath,
      LOG_LEVEL: process.env['LOG_LEVEL']?.trim() || 'warn',
    });
  } catch (err) {
    throw new DemoFail(err instanceof ConfigError ? err.message : errorMessage(err));
  }
}

/** `AGENT_PRIVATE_KEY`, or the key file next to the database, created on the first run. */
function loadAgentKey(databasePath: string): KeyObject {
  const fromEnv = process.env['AGENT_PRIVATE_KEY']?.trim();
  if (fromEnv) {
    try {
      return parseAgentKey(fromEnv);
    } catch (err) {
      throw new DemoFail(err instanceof AgentConfigError ? err.message : 'AGENT_PRIVATE_KEY is invalid.');
    }
  }
  const file = path.join(path.dirname(databasePath), 'demo-agent.key');
  if (existsSync(file)) {
    try {
      return importPrivateKeyRaw(readFileSync(file, 'utf8').trim());
    } catch {
      throw new DemoFail(`The agent key file ${file} is not a valid key. Delete it to create a new agent key.`);
    }
  }
  const key = generateAgentKey();
  mkdirSync(path.dirname(file), { recursive: true });
  // The mode has no effect on Windows; the repo's *.key ignore rule covers the file.
  writeFileSync(file, `${exportPrivateKeyRaw(key.privateKey)}\n`, { mode: 0o600 });
  out(`   Created a new agent key file: ${file}`);
  return key.privateKey;
}

function apiFor(base: string, key: string): Api {
  return async (method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  };
}

interface OperatorView {
  walletStatus: string;
  perCall: number;
}

async function readOperator(api: Api): Promise<OperatorView> {
  const res = await api('GET', '/v1/operator');
  const wallet = res.body['wallet'] as { status?: unknown } | undefined;
  const caps = res.body['caps'] as { perCall?: unknown } | undefined;
  if (res.status !== 200 || typeof wallet?.status !== 'string' || typeof caps?.perCall !== 'number') {
    throw new DemoFail(`Reading the operator failed (HTTP ${res.status}).`);
  }
  return { walletStatus: wallet.status, perCall: caps.perCall };
}

async function link(api: Api): Promise<void> {
  const started = await api('POST', '/v1/operator/wallet/link');
  if (started.status !== 200 || typeof started.body['approveUrl'] !== 'string') {
    throw new DemoFail(`Starting the link failed (HTTP ${started.status}, ${String(started.body['error'] ?? 'no error code')}).`);
  }
  out('   Open this link in a PRIVATE browser window, sign in with the US Personal sandbox account and approve:');
  out();
  out(`   ${started.body['approveUrl']}`);
  out();
  out('   Waiting for the wallet to become active (up to 10 minutes)...');
  const deadline = Date.now() + LINK_TIMEOUT_MS;
  let status = '';
  while (Date.now() < deadline) {
    const refresh = await api('POST', '/v1/operator/wallet/refresh');
    // An unchanged wallet or a 409 means keep polling; the browser return may finish first.
    const wallet = refresh.body['wallet'] as { status?: string } | undefined;
    status = wallet?.status ?? status;
    if (refresh.status === 200 && status === 'active') {
      out('   Wallet linked and active.');
      return;
    }
    if (status === 'link_failed') throw new DemoFail('The link failed (cancelled or expired).');
    await sleep(POLL_MS);
  }
  throw new DemoFail(`The wallet did not become active in time (status: ${status || 'unknown'}).`);
}

interface State {
  running?: RunningFacilitator;
  seller?: RunningSeller;
  runKeys: string[];
  pepper?: string;
}

async function run(args: Args, state: State): Promise<void> {
  const config = buildConfig();
  state.pepper = config.apiKeyPepper;

  // Step 1: the facilitator, with the demo database and its normal jobs.
  const running = await startFacilitator({ config, logger: createLogger(config.logLevel) });
  state.running = running;
  const base = `http://127.0.0.1:${running.port}`;
  out(`1. Facilitator running on port ${running.port} (PayPal API: ${config.paypalApiBase}).`);

  // Step 2: accounts, and run-scoped keys revoked at exit.
  const now = Math.floor(Date.now() / 1000);
  const seeded = seed(running.db, { now, pepper: config.apiKeyPepper });
  const operatorKey = issueApiKey(running.db, config.apiKeyPepper, 'operator', seeded.operatorId, KEY_LABEL, now);
  state.runKeys.push(operatorKey);
  const sellerKey = issueApiKey(running.db, config.apiKeyPepper, 'seller', seeded.sellerId, KEY_LABEL, now);
  state.runKeys.push(sellerKey);
  const api = apiFor(base, operatorKey);
  out('2. Demo accounts ready: operator "Northwind Research" and seller "Acme Data".');

  // Step 3: the agent key and the agent record.
  const privateKey = loadAgentKey(config.databasePath);
  const x = publicKeyX(privateKey);
  const agent = await ensureAgent(api, { name: AGENT_NAME, publicKeyX: x, kid: kidFromPublicKeyX(x) });
  out(`3. Agent "${AGENT_NAME}" is ${agent.status} (${agent.id}).`);

  // Step 4: the wallet.
  let operator = await readOperator(api);
  if (args.link && operator.walletStatus !== 'active') {
    out('4. Linking PayPal:');
    await link(api);
    operator = await readOperator(api);
  } else {
    out(`4. PayPal wallet: ${operator.walletStatus}.`);
    if (operator.walletStatus !== 'active') {
      out(`   Paid calls will be refused (wallet ${operator.walletStatus}). Run with --link to link PayPal.`);
    }
  }

  // Step 5: the seller, with the run's seller key.
  const model = process.env['ANTHROPIC_MODEL']?.trim() || DEFAULT_MODEL;
  const seller = await startSeller({
    port: Number(process.env['SELLER_PORT']?.trim() || '4021'),
    facilitatorUrl: base,
    sellerApiKey: sellerKey,
    ai: createClaudeSellerAi(new Anthropic({ timeout: SELLER_AI_TIMEOUT_MS, maxRetries: 0 }), model),
  });
  state.seller = seller;
  out(`5. Demo seller running at ${seller.url}.`);

  // Step 6: the agent, with the operator's per-call cap as its ceiling.
  const maxPerCallCents = Math.min(operator.perCall, args.budgetCents);
  out(`6. Agent run: budget ${formatUsd(args.budgetCents)}, per-call limit ${formatUsd(maxPerCallCents)}.`);
  const layer = setupDecisionLayer(args.decisionLayer, createJevSpendCheck);
  out(`   ${layer.line}`);
  out();
  const runStart = Math.floor(Date.now() / 1000);
  const session = await openSession({
    sellerUrl: seller.url,
    privateKey,
    budgetCents: args.budgetCents,
    maxPerCallCents,
    onEvent: (event) => {
      if (event.type !== 'result') out(`   ${formatEvent(event)}`);
    },
    ...(layer.spendCheck === undefined ? {} : { spendCheck: { checker: layer.spendCheck, task: args.task } }),
  });
  const result = await runAgent({ task: args.task, session, anthropic: new Anthropic(), model, signal: interrupt.signal });
  out();
  out(`   Status: ${result.status}`);
  out();
  for (const line of (result.answer || '(no answer)').split('\n')) out(`   ${line}`);
  out();
  for (const line of formatReport(result.report).split('\n')) out(`   ${line}`);
  out();

  // Step 7: the ledger check.
  const paid = result.events.flatMap((e) => (e.type === 'paid' ? [{ commitmentId: e.commitmentId, amountCents: e.amountCents }] : []));
  const ledger = await checkLedger(api, { agentId: agent.id, sinceSeconds: runStart, paid });
  out(`7. Ledger matches: ${ledger.count} paid calls, ${formatUsd(ledger.totalCents)}.`);

  // Step 8: settlement, gated on the wallet status known after step 4 (not re-read).
  const decision = settlementDecision({ settleFlag: args.settle, paidCalls: ledger.count, walletStatusAfterLink: operator.walletStatus });
  if (!decision.settle) {
    out(`8. ${decision.reason}`);
  } else {
    out('8. Settling with PayPal...');
    const summaries = await settleRun(
      { api, sleep, now: () => Date.now() },
      { agentId: agent.id, sinceSeconds: runStart, commitmentIds: result.report.commitmentIds },
    );
    for (const s of summaries) {
      out(`   Settlement ${s.id} completed: ${formatUsd(s.amountCents)} for ${s.calls} calls.`);
      out(`   PayPal order ${s.paypalOrderId ?? '?'}, capture ${s.paypalCaptureId ?? '?'}.`);
    }
    out('   Check them in the sandbox Business account: sandbox.paypal.com -> Activity.');
  }

  // Step 9: the result.
  if (result.status === 'error') throw new DemoFail('The agent run ended with status error.');
}

async function main(): Promise<void> {
  const state: State = { runKeys: [] };
  process.once('SIGINT', () => interrupt.abort());
  try {
    await run(parseCommandLine(), state);
    out('RESULT: PASS');
  } catch (err) {
    const reason = interrupt.signal.aborted ? 'Interrupted.' : err instanceof DemoFail ? err.message : errorMessage(err);
    out(`RESULT: FAIL. ${reason}`);
    process.exitCode = 1;
  } finally {
    if (state.running && state.pepper) {
      const revoke = state.running.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL');
      for (const key of state.runKeys) revoke.run(Math.floor(Date.now() / 1000), hashApiKey(state.pepper, key));
    }
    if (state.seller) await state.seller.close();
    if (state.running) await state.running.close();
  }
}

void main();
