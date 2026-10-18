/** Test helpers: fake PayPal gateway, harness, fixtures. Not part of the service. */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PayPalApiError,
  PayPalNetworkError,
  type ChargeResult,
  type ChargeVaultedWalletInput,
  type CreateSetupTokenInput,
  type CreatedSetupToken,
  type PaymentTokenResult,
  type SetupTokenResult,
  type VerifyWebhookSignatureInput,
} from '@payper402/paypal-client';
import { generateAgentKey, type AgentKey } from '@payper402/scheme-paypal';
import { createApp, createServices, type Services } from './app';
import { issueApiKey } from './auth';
import type { Config } from './config';
import { randomId } from './crypto';
import { openDatabase, type Db } from './db/connection';
import { runMigrations } from './db/migrations';
import type { CommitmentState, SettlementRow, WalletRow, WalletStatusRow } from './db/rows';
import { EventBus, type FacilitatorEvent } from './events';
import { silentLogger, type Logger } from './logger';
import type { PayPalGateway } from './paypal';

/** 2026-10-16T12:00:00Z. */
export const T0 = 1_792_152_000;

export const TEST_KEY_HEX = '0f'.repeat(32);
export const TEST_PEPPER = 'test-pepper-test-pepper-test-pepper-0123';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databasePath: ':memory:',
    publicBaseUrl: 'http://localhost:4020',
    paypalClientId: 'cid',
    paypalClientSecret: 'csecret',
    paypalApiBase: 'https://api-m.sandbox.paypal.com',
    paypalWebhookId: 'WH-TEST',
    dataEncryptionKey: Buffer.from(TEST_KEY_HEX, 'hex'),
    apiKeyPepper: TEST_PEPPER,
    settlementTickSeconds: 15,
    walletCheckIntervalSeconds: 30,
    logLevel: 'error',
    ...overrides,
  };
}

export const apiError = (httpStatus: number, issues: string[] = [], extra: { orderId?: string; path?: string } = {}) =>
  new PayPalApiError({
    httpStatus,
    name: httpStatus === 422 ? 'UNPROCESSABLE_ENTITY' : `HTTP_${httpStatus}`,
    message: 'fake',
    issues,
    method: 'POST',
    path: extra.path ?? '/v2/checkout/orders',
    ...(extra.orderId === undefined ? {} : { orderId: extra.orderId }),
  });

export const networkError = () => new PayPalNetworkError('POST', '/v2/checkout/orders', 'network error');

export const completedCharge = (amountCents: number, orderId = 'ORDER-1', captureId = 'CAP-1'): ChargeResult => ({
  orderId,
  orderStatus: 'COMPLETED',
  capture: { id: captureId, status: 'COMPLETED', amountCents, feeCents: 30, netCents: amountCents - 30 },
});

export const captureWith = (status: string, amountCents: number, orderId = 'ORDER-1', captureId = 'CAP-1'): ChargeResult => ({
  orderId,
  orderStatus: status === 'COMPLETED' ? 'COMPLETED' : 'COMPLETED',
  capture: { id: captureId, status, amountCents },
});

type Method = keyof PayPalGateway;
type ChargeScript = (input: ChargeVaultedWalletInput) => ChargeResult | Promise<ChargeResult>;
type OrderScript = (orderId: string) => ChargeResult | Promise<ChargeResult>;

interface Gate {
  release: () => void;
  wait: Promise<void>;
  entered: Promise<void>;
  enter: () => void;
}

/**
 * A fake PayPal gateway. Calls are recorded; charge and order answers can be scripted; and
 * `hold(method)` makes the next call to a method wait until the test releases it, which makes
 * race tests deterministic.
 */
export class FakePayPal implements PayPalGateway {
  readonly calls: { method: Method; args: unknown[] }[] = [];
  readonly setupTokens = new Map<string, string>();
  /** Payment token ids that exist at PayPal. */
  readonly paymentTokens = new Set<string>();
  readonly deletedTokens: string[] = [];
  readonly chargeScripts: ChargeScript[] = [];
  readonly orderScripts: OrderScript[] = [];
  /** Payment token returned per setup-token request id (idempotent like PayPal). */
  private readonly tokensByRequest = new Map<string, string>();
  private readonly gates = new Map<Method, Gate[]>();
  private counter = 0;
  payerEmail = 'buyer@example.com';
  webhookVerdict: (input: VerifyWebhookSignatureInput) => boolean = (input) =>
    input.headers['paypal-transmission-sig'] === 'valid';
  getPaymentTokenError: unknown = undefined;
  /**
   * When set, every new payment-token request returns this id, as PayPal does for a payer who
   * already holds a token with this merchant (design spec §5.1).
   */
  existingPaymentToken: string | undefined = undefined;

  /** The next call to `method` waits for `release()`. `entered` resolves once it is waiting. */
  hold(method: Method): { release: () => void; entered: Promise<void> } {
    let release: () => void = () => {};
    let enter: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate: Gate = { release, wait, entered, enter };
    const list = this.gates.get(method) ?? [];
    list.push(gate);
    this.gates.set(method, list);
    return { release, entered };
  }

  callsOf(method: Method): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  /** Adds an approved setup token, as if the payer approved in the browser. */
  approve(setupTokenId: string): void {
    this.setupTokens.set(setupTokenId, 'APPROVED');
  }

  /** Marks a setup token `VAULTED`, as after a payment token was created from it. */
  vault(setupTokenId: string): void {
    this.setupTokens.set(setupTokenId, 'VAULTED');
  }

  private async enter(method: Method, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const gate = this.gates.get(method)?.shift();
    if (gate) {
      gate.enter();
      await gate.wait;
    }
  }

  async createSetupToken(input: CreateSetupTokenInput): Promise<CreatedSetupToken> {
    await this.enter('createSetupToken', [input]);
    this.counter += 1;
    const id = `ST-${this.counter}`;
    this.setupTokens.set(id, 'PAYER_ACTION_REQUIRED');
    return { id, status: 'PAYER_ACTION_REQUIRED', approveUrl: `https://www.sandbox.paypal.com/approve?token=${id}` };
  }

  async getSetupToken(id: string): Promise<SetupTokenResult> {
    await this.enter('getSetupToken', [id]);
    const status = this.setupTokens.get(id);
    if (!status) throw apiError(404, ['RESOURCE_NOT_FOUND'], { path: `/v3/vault/setup-tokens/${id}` });
    return { id, status };
  }

  async createPaymentToken(setupTokenId: string, requestId: string): Promise<PaymentTokenResult> {
    await this.enter('createPaymentToken', [setupTokenId, requestId]);
    let id = this.tokensByRequest.get(requestId);
    if (!id) {
      this.counter += 1;
      id = this.existingPaymentToken ?? `PT-${this.counter}`;
      this.tokensByRequest.set(requestId, id);
      this.paymentTokens.add(id);
    }
    if (this.setupTokens.has(setupTokenId)) this.vault(setupTokenId);
    return { id, customerId: 'CUST-1', payerEmail: this.payerEmail };
  }

  async getPaymentToken(id: string): Promise<PaymentTokenResult> {
    await this.enter('getPaymentToken', [id]);
    if (this.getPaymentTokenError) throw this.getPaymentTokenError;
    if (!this.paymentTokens.has(id)) throw apiError(404, ['TOKEN_NOT_FOUND'], { path: `/v3/vault/payment-tokens/${id}` });
    return { id };
  }

  async deletePaymentToken(id: string): Promise<void> {
    await this.enter('deletePaymentToken', [id]);
    this.deletedTokens.push(id);
    if (!this.paymentTokens.delete(id)) throw apiError(404, ['TOKEN_NOT_FOUND']);
  }

  async chargeVaultedWallet(input: ChargeVaultedWalletInput): Promise<ChargeResult> {
    await this.enter('chargeVaultedWallet', [input]);
    const script = this.chargeScripts.shift();
    if (script) return script(input);
    return completedCharge(input.amountCents, `ORDER-${input.requestId}`, `CAP-${input.requestId}`);
  }

  async getOrder(orderId: string): Promise<ChargeResult> {
    await this.enter('getOrder', [orderId]);
    const script = this.orderScripts.shift();
    if (!script) throw new Error(`No scripted answer for getOrder(${orderId})`);
    return script(orderId);
  }

  async verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> {
    await this.enter('verifyWebhookSignature', [input]);
    return this.webhookVerdict(input);
  }
}

export interface Harness {
  db: Db;
  config: Config;
  clock: { now: number };
  paypal: FakePayPal;
  events: EventBus;
  seen: FacilitatorEvent[];
  services: Services;
  /** Starts the HTTP server on port 0 (once) and returns its base URL. */
  url(): Promise<string>;
  close(): Promise<void>;
  api(method: string, path: string, options?: { key?: string; body?: unknown; headers?: Record<string, string> }): Promise<{
    status: number;
    body: Record<string, unknown>;
    headers: Headers;
  }>;
  addOperator(options?: { caps?: { perCall: number; daily: number; unsettled: number; total?: number }; wallet?: WalletStatusRow }): {
    operatorId: string;
    key: string;
  };
  addSeller(): { sellerId: string; key: string };
  addAgent(operatorId: string, options?: { status?: 'active' | 'paused' }): { agentId: string; key: AgentKey };
  /** Puts a wallet into `active` with a stored payment token known to the fake. */
  activateWallet(operatorId: string, paymentTokenId?: string): string;
  addCommitment(input: {
    operatorId: string;
    agentId: string;
    payTo: string;
    amount: number;
    recordedAt?: number;
    state?: CommitmentState;
    resourceUrl?: string;
  }): string;
  wallet(operatorId: string): WalletRow;
  settlements(operatorId: string): SettlementRow[];
  commitmentStates(operatorId: string): Record<string, number>;
  /** Settlement invariants of design spec §5. Throws when one fails. */
  checkInvariants(): void;
}

export function createHarness(options: { config?: Partial<Config>; sseKeepaliveMs?: number; logger?: Logger } = {}): Harness {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const config = testConfig(options.config);
  const clock = { now: T0 };
  const paypal = new FakePayPal();
  const events = new EventBus(silentLogger);
  const seen: FacilitatorEvent[] = [];
  events.subscribe((event) => {
    seen.push(event);
  });
  const deps = {
    config,
    db,
    paypal,
    clock: () => clock.now,
    events,
    logger: options.logger ?? silentLogger,
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
  };
  const services = createServices(deps);
  const app = createApp(deps, services);
  let server: Server | undefined;
  let baseUrl: string | undefined;

  const url = async () => {
    if (baseUrl) return baseUrl;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return baseUrl;
  };

  const harness: Harness = {
    db,
    config,
    clock,
    paypal,
    events,
    seen,
    services,
    url,
    async close() {
      await services.settlements.background.idle();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
      events.dispose();
      db.close();
    },
    async api(method, path, opts = {}) {
      const base = await url();
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        redirect: 'manual',
        ...(opts.body === undefined ? {} : { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { text };
      }
      return { status: res.status, body, headers: res.headers };
    },
    addOperator(opts = {}) {
      const operatorId = randomId('op');
      const caps = opts.caps ?? { perCall: 25, daily: 1000, unsettled: 100 };
      db.prepare(
        `INSERT INTO operators (id, name, email, cap_per_call, cap_daily, cap_unsettled, cap_total, created_at)
         VALUES (?, 'Test operator', NULL, ?, ?, ?, ?, ?)`,
      ).run(operatorId, caps.perCall, caps.daily, caps.unsettled, caps.total ?? null, clock.now);
      db.prepare(`INSERT INTO wallets (operator_id, status, updated_at) VALUES (?, ?, ?)`).run(
        operatorId,
        opts.wallet ?? 'not_linked',
        clock.now,
      );
      return { operatorId, key: issueApiKey(db, config.apiKeyPepper, 'operator', operatorId, 'test', clock.now) };
    },
    addSeller() {
      const sellerId = randomId('sel');
      db.prepare('INSERT INTO sellers (id, name, created_at) VALUES (?, ?, ?)').run(sellerId, 'Test seller', clock.now);
      return { sellerId, key: issueApiKey(db, config.apiKeyPepper, 'seller', sellerId, 'test', clock.now) };
    },
    addAgent(operatorId, opts = {}) {
      const key = generateAgentKey();
      const agentId = randomId('agt');
      db.prepare(
        `INSERT INTO agents (id, operator_id, name, kid, public_key_x, status, created_at) VALUES (?, ?, 'Agent', ?, ?, ?, ?)`,
      ).run(agentId, operatorId, key.kid, key.publicKeyX, opts.status ?? 'active', clock.now);
      return { agentId, key };
    },
    activateWallet(operatorId, paymentTokenId = `PT-${operatorId}`) {
      paypal.paymentTokens.add(paymentTokenId);
      const box = services.ctx.box;
      db.prepare(
        `UPDATE wallets SET status = 'active', vault_id_sealed = ?, vault_id_hash = ?, linked_at = ?, payer_email_masked = 'bu***@example.com',
           updated_at = ? WHERE operator_id = ?`,
      ).run(box.seal(paymentTokenId), box.lookupHash(paymentTokenId), clock.now, clock.now, operatorId);
      return paymentTokenId;
    },
    addCommitment(input) {
      const id = randomId('cmt');
      db.prepare(
        `INSERT INTO commitments (id, kid, agent_id, operator_id, pay_to, resource_url, max_amount, amount, iat, recorded_at, state, payload_hash)
         VALUES (?, 'kid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.agentId,
        input.operatorId,
        input.payTo,
        input.resourceUrl ?? 'https://seller.test/api/quote?q=1',
        input.amount,
        input.amount,
        input.recordedAt ?? clock.now,
        input.recordedAt ?? clock.now,
        input.state ?? 'unsettled',
        `hash_${id}`,
      );
      return id;
    },
    wallet(operatorId) {
      return db.prepare('SELECT * FROM wallets WHERE operator_id = ?').get(operatorId) as WalletRow;
    },
    settlements(operatorId) {
      return db.prepare('SELECT * FROM settlements WHERE operator_id = ? ORDER BY created_at, rowid').all(operatorId) as SettlementRow[];
    },
    commitmentStates(operatorId) {
      const rows = db
        .prepare('SELECT state, COUNT(*) AS n FROM commitments WHERE operator_id = ? GROUP BY state')
        .all(operatorId) as { state: string; n: number }[];
      return Object.fromEntries(rows.map((row) => [row.state, row.n]));
    },
    checkInvariants() {
      const bad = db
        .prepare(
          `SELECT s.id, s.amount, s.calls_count, COALESCE(SUM(i.amount), 0) AS sum, COUNT(i.commitment_id) AS n
           FROM settlements s LEFT JOIN settlement_items i ON i.settlement_id = s.id
           GROUP BY s.id HAVING s.amount != sum OR s.calls_count != n`,
        )
        .all();
      if (bad.length > 0) throw new Error(`Settlement sums broken: ${JSON.stringify(bad)}`);
      const pending = db
        .prepare(`SELECT operator_id, COUNT(*) AS n FROM settlements WHERE status = 'pending' GROUP BY operator_id HAVING n > 1`)
        .all();
      if (pending.length > 0) throw new Error(`More than one pending settlement: ${JSON.stringify(pending)}`);
      const links = db
        .prepare(
          `SELECT id, state, settlement_id FROM commitments
           WHERE (state IN ('settling', 'settled') AND settlement_id IS NULL)`,
        )
        .all();
      if (links.length > 0) throw new Error(`Batch links broken: ${JSON.stringify(links)}`);
      const overcharged = db
        .prepare(
          `SELECT s.id FROM settlements s WHERE s.status = 'completed' AND s.amount >
             (SELECT COALESCE(SUM(c.max_amount), 0) FROM settlement_items i JOIN commitments c ON c.id = i.commitment_id WHERE i.settlement_id = s.id)`,
        )
        .all();
      if (overcharged.length > 0) throw new Error(`Settlement above signed maximums: ${JSON.stringify(overcharged)}`);
    },
  };
  return harness;
}

/** Reads SSE frames from a streaming response until `predicate` matches or the stream ends. */
export async function readFrames(
  res: Response,
  predicate: (frames: { event?: string; data?: unknown; comment?: string }[]) => boolean,
): Promise<{ event?: string; data?: unknown; comment?: string }[]> {
  const frames: { event?: string; data?: unknown; comment?: string }[] = [];
  const reader = res.body?.getReader();
  if (!reader) return frames;
  const decoder = new TextDecoder();
  let buffer = '';
  while (!predicate(frames)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const frame: { event?: string; data?: unknown; comment?: string } = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as unknown;
      }
      frames.push(frame);
    }
  }
  await reader.cancel();
  return frames;
}
