/**
 * PayPer402 sandbox end-to-end check (BUILD_SPEC Milestone 6). Runs against the REAL PayPal
 * sandbox and needs a human twice: to approve the link and to revoke it.
 *
 *   npm run sandbox-e2e -w apps/facilitator                 full run (link, charge, revoke)
 *   npm run sandbox-e2e -w apps/facilitator -- --skip-revoke stop after the charge
 *
 * Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (root .env). Optional: PORT (default 4020),
 * PUBLIC_BASE_URL (default http://localhost:<PORT>), PAYPAL_API_BASE, PAYPAL_WEBHOOK_ID.
 * DATA_ENCRYPTION_KEY and API_KEY_PEPPER are generated for the temporary database when unset.
 * Never prints secrets, API keys or vault ids.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { x402Client } from '@x402/core/client';
import { HTTPFacilitatorClient, decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import { wrapFetchWithPayment } from '@x402/fetch';
import {
  ErrorCode,
  PAYPAL_NETWORK_FAMILY,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchClientScheme,
  PayPalBatchServerScheme,
  SCHEME,
  generateAgentKey,
} from '@payper402/scheme-paypal';
import { issueApiKey } from '../src/auth';
import { ConfigError, loadConfig, type Config } from '../src/config';
import { randomId } from '../src/crypto';
import { createLogger, errorMessage } from '../src/logger';
import { startFacilitator, type RunningFacilitator } from '../src/server';

const REQUIRED = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] as const;
const LINK_TIMEOUT_MS = 10 * 60 * 1000;
const REVOKE_TIMEOUT_MS = 90 * 1000;
const POLL_MS = 3000;
const MAX_PAID_CALLS = 10;
const CAPS = { perCall: 5, daily: 1000, unsettled: 20 };

class Fail extends Error {}

/** The x402 error code of a 402 answer, or undefined when the header is absent or unreadable. */
function requiredError(res: Response): string | undefined {
  const header = res.headers.get('PAYMENT-REQUIRED');
  if (!header) return undefined;
  try {
    return decodePaymentRequiredHeader(header).error;
  } catch {
    return undefined;
  }
}

/** Ctrl+C aborts the waits, so the temporary database is still cleaned up. */
const interrupt = new AbortController();
const out = (line = '') => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => delay(ms, undefined, { signal: interrupt.signal });

function buildConfig(): Config {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Fail(
      `Missing required environment variables: ${missing.join(', ')}.\n` +
        'Set them in the root .env (see .env.example). The sandbox app must be linked to a US sandbox Business ' +
        'account with "Save payment methods" enabled.',
    );
  }
  const port = process.env['PORT']?.trim() || '4020';
  try {
    return loadConfig({
      ...process.env,
      PORT: port,
      PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL']?.trim() || `http://localhost:${port}`,
      DATABASE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'payper402-e2e-')), 'facilitator.db'),
      DATA_ENCRYPTION_KEY: process.env['DATA_ENCRYPTION_KEY']?.trim() || randomBytes(32).toString('hex'),
      API_KEY_PEPPER: process.env['API_KEY_PEPPER'] || randomBytes(32).toString('base64url'),
      WALLET_CHECK_INTERVAL_SECONDS: '10',
      SETTLEMENT_TICK_SECONDS: '5',
      LOG_LEVEL: process.env['LOG_LEVEL']?.trim() || 'warn',
    });
  } catch (err) {
    throw new Fail(err instanceof ConfigError ? err.message : errorMessage(err));
  }
}

interface Fixture {
  operatorKey: string;
  sellerKey: string;
  sellerId: string;
  agent: ReturnType<typeof generateAgentKey>;
}

function seedFixture(running: RunningFacilitator, config: Config): Fixture {
  const { db } = running;
  const now = Math.floor(Date.now() / 1000);
  const operatorId = randomId('op');
  const sellerId = randomId('sel');
  const agent = generateAgentKey();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO operators (id, name, email, cap_per_call, cap_daily, cap_unsettled, cap_total, created_at)
       VALUES (?, 'Sandbox E2E operator', NULL, ?, ?, ?, NULL, ?)`,
    ).run(operatorId, CAPS.perCall, CAPS.daily, CAPS.unsettled, now);
    db.prepare(`INSERT INTO wallets (operator_id, status, updated_at) VALUES (?, 'not_linked', ?)`).run(operatorId, now);
    db.prepare(
      `INSERT INTO agents (id, operator_id, name, kid, public_key_x, status, created_at) VALUES (?, ?, 'E2E agent', ?, ?, 'active', ?)`,
    ).run(randomId('agt'), operatorId, agent.kid, agent.publicKeyX, now);
    db.prepare(`INSERT INTO sellers (id, name, created_at) VALUES (?, 'Sandbox E2E seller', ?)`).run(sellerId, now);
  })();
  return {
    operatorKey: issueApiKey(db, config.apiKeyPepper, 'operator', operatorId, 'sandbox-e2e', now),
    sellerKey: issueApiKey(db, config.apiKeyPepper, 'seller', sellerId, 'sandbox-e2e', now),
    sellerId,
    agent,
  };
}

async function api(base: string, key: string, method: string, route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function startSeller(facilitatorUrl: string, fixture: Fixture): Promise<{ server: Server; url: string }> {
  const headers = { Authorization: `Bearer ${fixture.sellerKey}` };
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
      { 'GET /quote': { accepts: { scheme: SCHEME, network: PAYPAL_SANDBOX_NETWORK, payTo: fixture.sellerId, price: '$0.05' } } },
      resourceServer,
    ),
  );
  app.get('/quote', (_req, res) => {
    res.json({ quote: 42 });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function run(skipRevoke: boolean, state: { running?: RunningFacilitator; seller?: Server; dbDir?: string }): Promise<void> {
  const config = buildConfig();
  state.dbDir = path.dirname(config.databasePath);
  out(`PayPal API: ${config.paypalApiBase}`);

  // Step 1: facilitator and fixtures.
  const running = await startFacilitator({ config, logger: createLogger(config.logLevel) });
  state.running = running;
  const base = `http://127.0.0.1:${running.port}`;
  const fixture = seedFixture(running, config);
  out(`1. Facilitator running on port ${running.port}; operator, seller and agent seeded (caps: ${JSON.stringify(CAPS)}).`);

  // Step 2: link.
  const link = await api(base, fixture.operatorKey, 'POST', '/v1/operator/wallet/link');
  if (link.status !== 200 || typeof link.body['approveUrl'] !== 'string') {
    throw new Fail(`Starting the link failed (HTTP ${link.status}, ${String(link.body['error'] ?? 'no error code')}).`);
  }
  out('2. Open this link in a PRIVATE browser window, sign in with the US Personal sandbox account and approve:');
  out();
  out(`   ${link.body['approveUrl']}`);
  out();
  out('   Waiting for the wallet to become active (up to 10 minutes)...');
  const linkDeadline = Date.now() + LINK_TIMEOUT_MS;
  let walletStatus = '';
  while (Date.now() < linkDeadline) {
    const refresh = await api(base, fixture.operatorKey, 'POST', '/v1/operator/wallet/refresh');
    // An unchanged wallet or a 409 means keep polling; the browser return may finish first.
    const wallet = refresh.body['wallet'] as { status?: string } | undefined;
    walletStatus = wallet?.status ?? walletStatus;
    if (refresh.status === 200 && walletStatus === 'active') break;
    if (walletStatus === 'link_failed') throw new Fail('The link failed (cancelled or expired).');
    await sleep(POLL_MS);
  }
  if (walletStatus !== 'active') throw new Fail(`The wallet did not become active in time (status: ${walletStatus || 'unknown'}).`);
  out('   Wallet linked and active.');

  // Step 3: paid calls until a threshold settlement completes.
  const seller = await startSeller(base, fixture);
  state.seller = seller.server;
  const pay = wrapFetchWithPayment(
    fetch,
    new x402Client().register(PAYPAL_NETWORK_FAMILY, new PayPalBatchClientScheme({ privateKey: fixture.agent.privateKey })),
  );
  out(`3. Making $0.05 paid calls until a threshold settlement (at ${CAPS.unsettled - CAPS.perCall} cents) completes...`);
  let completed: Record<string, unknown> | undefined;
  for (let call = 1; call <= MAX_PAID_CALLS && !completed; call += 1) {
    const res = await pay(`${seller.url}/quote`);
    if (res.status !== 200) {
      const reason = requiredError(res);
      out(`   call ${call}: HTTP ${res.status} ${reason ?? ''}`);
    } else {
      const header = res.headers.get('PAYMENT-RESPONSE');
      let amount = '?';
      try {
        if (header) amount = decodePaymentResponseHeader(header).amount ?? '?';
      } catch {
        amount = '?';
      }
      out(`   call ${call}: paid ${amount} cents`);
    }
    await running.services.settlements.background.idle();
    const list = await api(base, fixture.operatorKey, 'GET', '/v1/settlements');
    const settlements = (list.body['settlements'] as Record<string, unknown>[] | undefined) ?? [];
    completed = settlements.find((s) => s['status'] === 'completed');
    const failed = settlements.find((s) => s['status'] === 'failed' || s['status'] === 'needs_review');
    if (failed) throw new Fail(`Settlement ${String(failed['id'])} is ${String(failed['status'])}: ${String(failed['failureReason'] ?? '')}`);
  }
  const pendingDeadline = Date.now() + 60_000;
  while (!completed && Date.now() < pendingDeadline) {
    await sleep(POLL_MS);
    const list = await api(base, fixture.operatorKey, 'GET', '/v1/settlements');
    completed = ((list.body['settlements'] as Record<string, unknown>[] | undefined) ?? []).find((s) => s['status'] === 'completed');
  }
  if (!completed) throw new Fail('No settlement completed.');
  const detail = await api(base, fixture.operatorKey, 'GET', `/v1/settlements/${String(completed['id'])}`);
  const settlement = detail.body['settlement'] as Record<string, unknown> & { commitments: { amount: number }[] };
  const sum = settlement.commitments.reduce((total, c) => total + c.amount, 0);
  if (settlement['amount'] !== sum) throw new Fail(`Settlement amount ${String(settlement['amount'])} != sum of commitments ${sum}.`);
  if (settlement['captureStatus'] !== 'COMPLETED') throw new Fail(`PayPal capture status is ${String(settlement['captureStatus'])}.`);
  out(`   Settlement ${String(settlement['id'])} completed: ${sum} cents for ${settlement.commitments.length} calls.`);
  out(`   PayPal order ${String(settlement['paypalOrderId'])}, capture ${String(settlement['paypalCaptureId'])}.`);
  out('   Check them in the sandbox Business account: sandbox.paypal.com -> Activity.');

  if (skipRevoke) {
    out('--skip-revoke: stopping after the charge.');
    return;
  }

  // Step 4: the human revokes.
  out('4. Revoke the agreement now:');
  out('   - sign in to sandbox.paypal.com with the US Personal sandbox account');
  out('   - open the settings for automatic payments (Settings -> Payments -> Manage automatic payments)');
  out('   - select the merchant "PayPer402" and stop the agreement');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('   Press Enter once you have stopped it... ', { signal: interrupt.signal });
  rl.close();

  // Step 5: wait for revocation, then a paid call must be refused.
  out('5. Waiting up to 90 s for the facilitator to notice (health check every 10 s)...');
  const revokeDeadline = Date.now() + REVOKE_TIMEOUT_MS;
  let status = '';
  while (Date.now() < revokeDeadline) {
    const overview = await api(base, fixture.operatorKey, 'GET', '/v1/operator');
    status = (overview.body['wallet'] as { status?: string } | undefined)?.status ?? '';
    if (status === 'stopped_by_payer') break;
    await sleep(POLL_MS);
  }
  if (status !== 'stopped_by_payer') throw new Fail(`The wallet was not revoked in time (status: ${status || 'unknown'}).`);
  out('   Wallet is stopped_by_payer.');
  const refused = await pay(`${seller.url}/quote`);
  const reason = requiredError(refused);
  if (refused.status !== 402 || reason !== ErrorCode.walletRevoked) {
    throw new Fail(`Expected 402 ${ErrorCode.walletRevoked}, got HTTP ${refused.status} ${reason ?? ''}.`);
  }
  out(`   The next paid call got 402 ${reason}.`);
}

async function main(): Promise<void> {
  const state: { running?: RunningFacilitator; seller?: Server; dbDir?: string } = {};
  process.once('SIGINT', () => interrupt.abort());
  try {
    await run(process.argv.includes('--skip-revoke'), state);
    out('RESULT: PASS');
  } catch (err) {
    const reason = interrupt.signal.aborted ? 'Interrupted.' : err instanceof Fail ? err.message : errorMessage(err);
    out(`RESULT: FAIL. ${reason}`);
    process.exitCode = 1;
  } finally {
    if (state.seller) {
      state.seller.closeAllConnections();
      await new Promise<void>((resolve) => state.seller?.close(() => resolve()));
    }
    if (state.running) await state.running.close();
    if (state.dbDir) rmSync(state.dbDir, { recursive: true, force: true });
  }
}

void main();
