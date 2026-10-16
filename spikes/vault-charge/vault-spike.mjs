#!/usr/bin/env node
// PayPer402 vault spike.
//
// Question this answers: can a merchant save a payer's PayPal wallet once
// (Vault v3, save without purchase) and later charge it with no payer present
// (merchant-initiated transaction)? If yes, an AI agent can pay per use behind
// an HTTP 402 gateway without a human clicking "approve" on every payment.
//
// Node 18+, no dependencies. Sandbox only: the live API host is refused.
//
//   node vault-spike.mjs                 save wallet (payer approves once), then charge it
//   node vault-spike.mjs charge [amount] charge the saved wallet again, no payer involved
//   node vault-spike.mjs status          show the saved payment token
//   node vault-spike.mjs delete          delete the saved payment token

import http from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(HERE, '.env'));

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const API_BASE = resolveApiBase(process.env.PAYPAL_API_BASE);
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 8787);
const RETURN_BASE = (process.env.RETURN_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const USAGE_PATTERN = process.env.USAGE_PATTERN || 'IMMEDIATE';
// Off by default: PayPal's guide charges a vaulted wallet with vault_id alone.
const SEND_STORED_CREDENTIAL = process.env.STORED_CREDENTIAL === 'on';
const BRAND_NAME = process.env.BRAND_NAME || 'PayPer402 Sandbox';
const STATE_FILE = process.env.VAULT_STATE_FILE || path.join(HERE, '.vault-state.json');
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

class PayPalError extends Error {
  constructor(method, url, status, body, debugId) {
    const name = body?.name || body?.error || `HTTP_${status}`;
    const message = body?.message || body?.error_description || '';
    super(`${method} ${url} -> ${status} ${name}${message ? `: ${message}` : ''}`);
    this.status = status;
    this.body = body;
    this.debugId = debugId || body?.debug_id;
  }
}

// A failed verdict whose explanation is already in the message.
class SpikeFail extends Error {}

// Failures set exitCode instead of calling process.exit(): exiting while
// sockets are still closing aborts Node on Windows.
main().catch((err) => {
  process.exitCode = 1;
  if (err instanceof SpikeFail) {
    console.error(`\n${err.message}`);
    return;
  }
  console.error(`\n✗ ${err.message}`);
  if (err instanceof PayPalError) {
    if (err.body?.details) console.error('  details:', JSON.stringify(err.body.details, null, 2));
    if (err.debugId) console.error(`  paypal-debug-id: ${err.debugId}`);
  }
  console.error('\nRESULT: FAIL. See "Troubleshooting" in README.md.');
});

async function main() {
  const [command = 'run', arg] = process.argv.slice(2);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Copy .env.example to .env and fill them in.');
  }
  console.log(`API: ${API_BASE}`);

  switch (command) {
    case 'run':
      return runFullFlow(parseAmount(arg || process.env.CHARGE_AMOUNT || '1.00'));
    case 'charge':
      return chargeAgain(parseAmount(arg || process.env.CHARGE_AMOUNT || '1.00'));
    case 'status':
      return showStatus();
    case 'delete':
      return deleteToken();
    default:
      throw new Error(`Unknown command: ${command}. Use: run | charge [amount] | status | delete`);
  }
}

async function runFullFlow(amount) {
  const accessToken = await getAccessToken();
  console.log('✓ Got access token');

  const server = await startReturnServer();
  try {
    const setupToken = await createSetupToken(accessToken);
    const approveUrl = setupToken.links?.find((l) => l.rel === 'approve')?.href;
    if (!approveUrl) throw new Error(`Setup token ${setupToken.id} has no approve link (status ${setupToken.status}).`);
    console.log(`✓ Created setup token ${setupToken.id} (status ${setupToken.status}, usage_pattern ${USAGE_PATTERN})`);

    console.log('\n→ Open this link in a browser, sign in with the PERSONAL sandbox account and approve:');
    console.log(`\n  ${approveUrl}\n`);
    console.log('  Waiting for approval (up to 10 minutes)...');

    await waitForApproval(accessToken, setupToken.id, server);
    console.log('✓ Payer approved saving their PayPal wallet');

    const paymentToken = await createPaymentToken(accessToken, setupToken.id);
    const state = {
      paymentTokenId: paymentToken.id,
      customerId: paymentToken.customer?.id,
      payerEmail: paymentToken.payment_source?.paypal?.email_address,
      usagePattern: USAGE_PATTERN,
      apiBase: API_BASE,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`✓ Wallet saved: payment token ${state.paymentTokenId} (customer ${state.customerId}, ${state.payerEmail})`);
    console.log(`  Written to ${path.basename(STATE_FILE)}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }

  console.log('\n— From here on, NO payer is involved —\n');
  await chargeSaved(accessToken, readState(), amount);
}

async function chargeAgain(amount) {
  const state = readState();
  const accessToken = await getAccessToken();
  console.log(`✓ Got access token. Charging token ${state.paymentTokenId} (${state.payerEmail})`);
  await chargeSaved(accessToken, state, amount);
}

async function chargeSaved(accessToken, state, amount) {
  const order = await createOrderWithVault(accessToken, state, amount);
  console.log(`✓ Created order ${order.id}: status ${order.status}`);

  let finalOrder = order;
  if (order.status === 'APPROVED' || order.status === 'CREATED') {
    finalOrder = await api('POST', `/v2/checkout/orders/${order.id}/capture`, {
      token: accessToken,
      headers: { 'PayPal-Request-Id': randomUUID(), Prefer: 'return=representation' },
    });
    console.log(`✓ Captured order ${order.id}: status ${finalOrder.status}`);
  } else if (order.status === 'PAYER_ACTION_REQUIRED') {
    throw new SpikeFail(
      'RESULT: FAIL. PayPal requires payer action (PAYER_ACTION_REQUIRED).\n' +
        'The saved token does NOT let the merchant charge on its own. The PayPer402 premise does not hold with this setup.',
    );
  }

  const capture = finalOrder.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) {
    throw new SpikeFail(
      `RESULT: UNCLEAR. Order ${finalOrder.id} has status ${finalOrder.status} but no capture.\n` +
        JSON.stringify(finalOrder, null, 2),
    );
  }

  console.log(`  capture ${capture.id}: ${capture.status} ${capture.amount?.value} ${capture.amount?.currency_code}`);
  const breakdown = capture.seller_receivable_breakdown;
  if (breakdown) {
    console.log(`  PayPal fee: ${breakdown.paypal_fee?.value ?? '?'}, merchant receives: ${breakdown.net_amount?.value ?? '?'}`);
  }

  if (capture.status === 'COMPLETED') {
    console.log('\nRESULT: PASS. The merchant charged the saved wallet with no payer approval.');
    console.log('Double-check: sign in to sandbox.paypal.com with the Business account → Activity.');
  } else if (capture.status === 'PENDING') {
    console.log(`\nRESULT: CONDITIONAL PASS. The charge went through but the capture is PENDING (${capture.status_details?.reason ?? 'no reason given'}).`);
  } else {
    throw new SpikeFail(`RESULT: FAIL. Capture status ${capture.status}.`);
  }
}

async function showStatus() {
  const state = readState();
  const accessToken = await getAccessToken();
  const token = await api('GET', `/v3/vault/payment-tokens/${state.paymentTokenId}`, { token: accessToken });
  console.log(JSON.stringify(token, null, 2));
}

async function deleteToken() {
  const state = readState();
  const accessToken = await getAccessToken();
  await api('DELETE', `/v3/vault/payment-tokens/${state.paymentTokenId}`, { token: accessToken });
  rmSync(STATE_FILE, { force: true });
  console.log(`✓ Deleted payment token ${state.paymentTokenId} and ${path.basename(STATE_FILE)}`);
}

// --- PayPal calls ---------------------------------------------------------

async function getAccessToken() {
  const res = await api('POST', '/v1/oauth2/token', {
    rawBody: 'grant_type=client_credentials',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return res.access_token;
}

function createSetupToken(accessToken) {
  return api('POST', '/v3/vault/setup-tokens', {
    token: accessToken,
    headers: { 'PayPal-Request-Id': randomUUID() },
    body: {
      payment_source: {
        paypal: {
          description: 'PayPer402: AI agent pays per API call, billed to this PayPal account',
          permit_multiple_payment_tokens: false,
          usage_pattern: USAGE_PATTERN,
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          experience_context: {
            brand_name: BRAND_NAME,
            locale: 'en-US',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${RETURN_BASE}/return`,
            cancel_url: `${RETURN_BASE}/cancel`,
          },
        },
      },
    },
  });
}

function createPaymentToken(accessToken, setupTokenId) {
  return api('POST', '/v3/vault/payment-tokens', {
    token: accessToken,
    headers: { 'PayPal-Request-Id': randomUUID() },
    body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
  });
}

function createOrderWithVault(accessToken, state, amount) {
  const paypal = { vault_id: state.paymentTokenId };
  if (SEND_STORED_CREDENTIAL) {
    // `usage` is left to PayPal (DERIVED): the first charge after a save
    // without purchase has no earlier payment to be SUBSEQUENT to.
    paypal.stored_credential = {
      payment_initiator: 'MERCHANT',
      usage_pattern: state.usagePattern,
    };
  }
  return api('POST', '/v2/checkout/orders', {
    token: accessToken,
    headers: { 'PayPal-Request-Id': randomUUID(), Prefer: 'return=representation' },
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `spike-${Date.now()}`,
          description: 'PayPer402 spike: batched API usage',
          amount: { currency_code: 'USD', value: amount },
        },
      ],
      payment_source: { paypal },
    },
  });
}

async function api(method, urlPath, { token, body, rawBody, headers = {} } = {}) {
  const url = `${API_BASE}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : rawBody,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new PayPalError(method, urlPath, res.status, json, res.headers.get('paypal-debug-id'));
  return json;
}

// --- Approval wait --------------------------------------------------------

function startReturnServer() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/return' || pathname === '/cancel') {
      server.emit(pathname.slice(1));
      const text = pathname === '/return'
        ? 'PayPal responded. Go back to the terminal to see the result.'
        : 'You cancelled. Go back to the terminal.';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>PayPer402 spike</title><p style="font:16px system-ui;padding:24px">${text}</p>`);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(`Cannot listen on port ${PORT}: ${err.message}. Change PORT in .env.`)));
    server.listen(PORT, () => resolve(server));
  });
}

function waitForApproval(accessToken, setupTokenId, server) {
  return new Promise((resolve, reject) => {
    let timer;
    let busy = false;
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    const finish = (fn, value) => {
      clearInterval(timer);
      server.removeAllListeners('return');
      server.removeAllListeners('cancel');
      fn(value);
    };
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const st = await api('GET', `/v3/vault/setup-tokens/${setupTokenId}`, { token: accessToken });
        if (st.status === 'APPROVED') return finish(resolve, st);
        if (Date.now() > deadline) finish(reject, new Error(`Timed out after 10 minutes; setup token is still ${st.status}.`));
      } catch (err) {
        finish(reject, err);
      } finally {
        busy = false;
      }
    };
    server.on('return', check);
    server.on('cancel', () => finish(reject, new Error('The payer cancelled on the PayPal page.')));
    timer = setInterval(check, POLL_INTERVAL_MS);
  });
}

// --- Helpers --------------------------------------------------------------

function resolveApiBase(value) {
  if (!value || value === SANDBOX_BASE) return SANDBOX_BASE;
  // Localhost is allowed only so the script can be exercised against a mock.
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) return value;
  throw new Error(`PAYPAL_API_BASE=${value} refused: this spike only runs on the sandbox (${SANDBOX_BASE}).`);
}

function parseAmount(value) {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
    throw new Error(`Invalid amount: ${value}. Example: 1.00`);
  }
  return Number(value).toFixed(2);
}

function readState() {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`${path.basename(STATE_FILE)} not found. Run "node vault-spike.mjs" first to save a wallet.`);
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (state.apiBase !== API_BASE) {
    throw new Error(`The token in ${path.basename(STATE_FILE)} belongs to ${state.apiBase}, not ${API_BASE}.`);
  }
  return state;
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
