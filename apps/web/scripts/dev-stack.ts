/**
 * `npm run dev:stack`: the facilitator, the demo seller and the web app in one command (build spec,
 * "npm run dev:stack"). The facilitator and the seller run in this process; Next runs as a child.
 *
 *   npm run dev:stack            next dev on :3000
 *   npm run dev:stack -- --prod  next start on :3000 (run `npm run build -w apps/web` first)
 *
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, DATA_ENCRYPTION_KEY, API_KEY_PEPPER and Anthropic
 * credentials (root .env). Without WEB_SESSION_SECRET it keeps a generated one in
 * data/web-session.key, so sessions survive restarts. Never prints keys.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { SELLER_AI_TIMEOUT_MS, createClaudeSellerAi, startSeller, type RunningSeller } from '@payper402/demo-seller';
import { hashApiKey, issueApiKey } from '@payper402/facilitator/auth';
import { ConfigError, loadConfig } from '@payper402/facilitator/config';
import { createLogger, errorMessage } from '@payper402/facilitator/logger';
import { seed } from '@payper402/facilitator/seed';
import { startFacilitator, type RunningFacilitator } from '@payper402/facilitator/server';
import { firstBusyPort, portInUseMessage } from '../src/lib/ports';
import { SESSION_KEY_FILE, resolveSessionSecret } from '../src/lib/session-secret';

const FACILITATOR_PORT = 4020;
const SELLER_PORT = 4021;
const WEB_PORT = 3000;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const FACILITATOR_URL = `http://localhost:${FACILITATOR_PORT}`;
const SELLER_URL = `http://localhost:${SELLER_PORT}`;
const KEY_LABEL = 'dev-stack';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const repoRoot = path.resolve(webDir, '../..');
const out = (line = '') => process.stdout.write(`${line}\n`);

/** True when nothing answers on the port and this process could listen on it. */
async function portIsFree(port: number): Promise<boolean> {
  const answers = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
  if (answers) return false;
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

function missingVariables(): string[] {
  const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'DATA_ENCRYPTION_KEY', 'API_KEY_PEPPER'].filter((name) => !process.env[name]?.trim());
  const anthropic = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE'].some((name) => process.env[name]?.trim());
  if (!anthropic) missing.push('ANTHROPIC_API_KEY (or another Anthropic credential)');
  return missing;
}

interface State {
  facilitator?: RunningFacilitator;
  seller?: RunningSeller;
  child?: ChildProcess;
  sellerKey?: string;
  pepper?: string;
  stopping?: boolean;
}

function pipe(stream: NodeJS.ReadableStream | null, write: (line: string) => void): void {
  if (stream === null) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      write(`[web] ${buffer.slice(0, index)}\n`);
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on('end', () => {
    if (buffer !== '') write(`[web] ${buffer}\n`);
  });
}

async function shutdown(state: State, code: number): Promise<void> {
  if (state.stopping) return;
  state.stopping = true;
  if (state.child !== undefined && state.child.exitCode === null) {
    state.child.kill();
  }
  if (state.facilitator !== undefined && state.sellerKey !== undefined && state.pepper !== undefined) {
    state.facilitator.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL')
      .run(Math.floor(Date.now() / 1000), hashApiKey(state.pepper, state.sellerKey));
  }
  await state.seller?.close().catch(() => undefined);
  await state.facilitator?.close().catch(() => undefined);
  process.exitCode = code;
}

async function main(): Promise<void> {
  const prod = process.argv.includes('--prod');
  // 0. Every port must be free before anything starts.
  const busy = await firstBusyPort([WEB_PORT, FACILITATOR_PORT, SELLER_PORT], portIsFree);
  if (busy !== undefined) {
    out(portInUseMessage(busy));
    process.exitCode = 1;
    return;
  }
  const missing = missingVariables();
  if (missing.length > 0) {
    out(`Missing required environment variables: ${missing.join(', ')}.`);
    out('Set them in the root .env (see .env.example).');
    process.exitCode = 1;
    return;
  }

  // The session secret, before anything starts: a malformed kept file fails here, so no server
  // is left running and no seller key is issued.
  const databasePath = path.join(repoRoot, 'data', 'stack.db');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const session = resolveSessionSecret(process.env['WEB_SESSION_SECRET'], path.join(repoRoot, SESSION_KEY_FILE));
  if (!session.ok) {
    out(session.message);
    process.exitCode = 1;
    return;
  }
  if (session.message !== undefined) out(session.message);

  const state: State = {};
  const stop = () => void shutdown(state, 0);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', () => {
    // Last resort on Windows: never leave the Next child behind.
    if (state.child !== undefined && state.child.exitCode === null) state.child.kill();
  });

  // 1. The facilitator, in process, with its normal jobs.
  const adminKey = process.env['ADMIN_API_KEY']?.trim() || randomBytes(32).toString('hex');
  let config;
  try {
    config = loadConfig({
      ...process.env,
      PORT: String(FACILITATOR_PORT),
      PUBLIC_BASE_URL: FACILITATOR_URL,
      WEB_APP_URL: WEB_URL,
      DATABASE_PATH: databasePath,
      ADMIN_API_KEY: adminKey,
      LOG_LEVEL: process.env['LOG_LEVEL']?.trim() || 'warn',
    });
  } catch (err) {
    out(err instanceof ConfigError ? err.message : errorMessage(err));
    process.exitCode = 1;
    return;
  }
  state.pepper = config.apiKeyPepper;
  try {
    state.facilitator = await startFacilitator({ config, logger: createLogger(config.logLevel) });
    out(`Facilitator  ${FACILITATOR_URL}  (database ${path.relative(repoRoot, databasePath)})`);

    // 2. The seller account, and a run-scoped seller key.
    const now = Math.floor(Date.now() / 1000);
    const seeded = seed(state.facilitator.db, { now, pepper: config.apiKeyPepper });
    state.sellerKey = issueApiKey(state.facilitator.db, config.apiKeyPepper, 'seller', seeded.sellerId, KEY_LABEL, now);

    // 3. The demo seller, in process.
    const model = process.env['ANTHROPIC_MODEL']?.trim() || 'claude-opus-5-5';
    state.seller = await startSeller({
      port: SELLER_PORT,
      facilitatorUrl: FACILITATOR_URL,
      sellerApiKey: state.sellerKey,
      ai: createClaudeSellerAi(new Anthropic({ timeout: SELLER_AI_TIMEOUT_MS, maxRetries: 0 }), model),
    });
    out(`Demo seller  ${SELLER_URL}`);
  } catch (err) {
    out(`The stack failed to start: ${errorMessage(err)}`);
    await shutdown(state, 1);
    return;
  }

  // 4. Next, as a child process (never through a shell).
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, prod ? 'start' : 'dev', '--port', String(WEB_PORT)], {
    cwd: webDir,
    env: {
      ...process.env,
      FACILITATOR_URL,
      FACILITATOR_ADMIN_KEY: adminKey,
      WEB_SELLER_API_KEY: state.sellerKey,
      SELLER_URL,
      WEB_PUBLIC_URL: WEB_URL,
      WEB_SESSION_SECRET: session.secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  pipe(child.stdout, (line) => process.stdout.write(line));
  pipe(child.stderr, (line) => process.stderr.write(line));
  child.once('exit', (code) => {
    if (!state.stopping) out(`The web app exited (code ${code ?? 'none'}).`);
    void shutdown(state, code ?? 0);
  });
  out(`Web app      ${WEB_URL}  (next ${prod ? 'start' : 'dev'})`);
  out('Press Ctrl+C to stop.');
}

main().catch((err: unknown) => {
  out(`dev:stack failed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
