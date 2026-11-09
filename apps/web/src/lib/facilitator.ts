/**
 * Typed client for the facilitator's `/v1` API (design spec §7). The facilitator exports no view
 * types, so the response shapes are declared here with zod and every response is parsed. Errors are
 * mapped once, here, to what may reach the browser.
 */
import { brand, FACILITATOR_ERROR, hasBrand } from './brand';
import { z } from 'zod';

const cents = z.number().int();
const unix = z.number().int();
const nullableUnix = unix.nullable();

export const capsSchema = z.object({
  perCall: cents,
  daily: cents,
  unsettled: cents,
  total: cents.optional(),
});
export type Caps = z.output<typeof capsSchema>;

export const walletSchema = z.object({
  status: z.string(),
  payerEmailMasked: z.string().nullable(),
  linkedAt: nullableUnix,
  stoppedAt: nullableUnix,
  lastChargeAt: nullableUnix,
  lastChargeAmount: cents.nullable(),
  lastChargeStatus: z.string().nullable(),
  linkError: z.string().nullable(),
});
export type Wallet = z.output<typeof walletSchema>;

export const settlementSchema = z.object({
  id: z.string(),
  createdAt: unix,
  updatedAt: unix,
  completedAt: nullableUnix,
  trigger: z.string(),
  status: z.string(),
  amount: cents,
  callsCount: z.number().int(),
  paypalOrderId: z.string().nullable(),
  paypalCaptureId: z.string().nullable(),
  captureStatus: z.string().nullable(),
  fee: cents.nullable(),
  net: cents.nullable(),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: nullableUnix,
});
export type Settlement = z.output<typeof settlementSchema>;

export const blockReasonSchema = z.enum(['wallet_not_active', 'daily', 'unsettled', 'total']).nullable();

export const operatorViewSchema = z.object({
  operator: z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), createdAt: unix }),
  wallet: walletSchema,
  caps: capsSchema,
  usage: z.object({
    spentToday: cents,
    notYetCharged: cents,
    spentTotal: cents,
    notYetChargedCalls: z.number().int(),
    chargeable: cents,
    chargeableCalls: z.number().int(),
    notCollected: cents,
    notCollectedCalls: z.number().int(),
  }),
  activeAgents: z.number().int(),
  lastSettlement: settlementSchema.nullable(),
  blockReason: blockReasonSchema,
});
export type OperatorView = z.output<typeof operatorViewSchema>;

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kid: z.string(),
  keyFingerprint: z.string(),
  status: z.string(),
  createdAt: unix,
});
export type Agent = z.output<typeof agentSchema>;

export const agentWithUsageSchema = agentSchema.extend({
  spentToday: cents,
  spentTotal: cents,
  callsToday: z.number().int(),
  lastCallAt: nullableUnix,
  blocked: z.boolean(),
  blockReason: blockReasonSchema,
});
export type AgentWithUsage = z.output<typeof agentWithUsageSchema>;

export const commitmentSchema = z.object({
  id: z.string(),
  recordedAt: unix,
  agentId: z.string(),
  agentName: z.string(),
  payTo: z.string(),
  resourceUrl: z.string(),
  path: z.string(),
  amount: cents,
  maxAmount: cents,
  state: z.string(),
  settlementId: z.string().nullable(),
});
export type Commitment = z.output<typeof commitmentSchema>;

export const settlementDetailSchema = settlementSchema.extend({ commitments: z.array(commitmentSchema) });
export type SettlementDetail = z.output<typeof settlementDetailSchema>;

export const sellerCommitmentSchema = z.object({
  id: z.string(),
  recordedAt: unix,
  agentRef: z.string(),
  payTo: z.string(),
  resourceUrl: z.string(),
  path: z.string(),
  amount: cents,
  maxAmount: cents,
  state: z.string(),
  settlementId: z.string().nullable(),
});
export type SellerCommitment = z.output<typeof sellerCommitmentSchema>;

export const sellerViewSchema = z.object({
  seller: z.object({ id: z.string(), name: z.string(), createdAt: unix }),
  usage: z.object({
    revenueToday: cents,
    revenueTotal: cents,
    pending: cents,
    pendingCalls: z.number().int(),
    callsToday: z.number().int(),
    uniqueAgentsToday: z.number().int(),
  }),
});
export type SellerView = z.output<typeof sellerViewSchema>;

export const sellerSettlementSchema = z.object({
  id: z.string(),
  createdAt: unix,
  status: z.string(),
  sellerAmount: cents,
  sellerCalls: z.number().int(),
  feeShare: cents.nullable(),
  netShare: cents.nullable(),
});
export type SellerSettlement = z.output<typeof sellerSettlementSchema>;

export const claimSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), expiresAt: unix });
export type Claim = z.output<typeof claimSchema>;

export const demoOperatorSchema = z.object({ operator: z.object({ id: z.string(), name: z.string() }), apiKey: z.string() });

const issuesSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export type KeyKind = 'operator' | 'seller' | 'admin';

/**
 * An error ready for the browser (design spec §7): `status` and `code` are what the web route
 * answers. `body` is the facilitator's 409 body, passed through.
 */
export class FacilitatorError extends Error {
  override readonly name = 'FacilitatorError';
  readonly status: number;
  readonly code: string;
  readonly ref: string | undefined;
  readonly issues: z.output<typeof issuesSchema> | undefined;
  readonly body: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { ref?: string | undefined; issues?: z.output<typeof issuesSchema> | undefined; body?: Record<string, unknown> | undefined } = {},
  ) {
    super(message);
    brand(this, FACILITATOR_ERROR);
    this.status = status;
    this.code = code;
    this.ref = extra.ref;
    this.issues = extra.issues;
    this.body = extra.body;
  }

  toJSON(): Record<string, unknown> {
    if (this.body !== undefined) return { ...this.body, error: this.code, message: this.message };
    return {
      error: this.code,
      message: this.message,
      ...(this.ref === undefined ? {} : { ref: this.ref }),
      ...(this.issues === undefined ? {} : { issues: this.issues }),
    };
  }
}

/** `instanceof FacilitatorError` across server chunks (see `brand.ts`). */
export function isFacilitatorError(value: unknown): value is FacilitatorError {
  return hasBrand(value, FACILITATOR_ERROR);
}

export const UPSTREAM_MESSAGE = 'Something went wrong. Try again in a moment.';

/** Maps a facilitator answer that is not a success (design spec §7). */
export function mapError(status: number, body: Record<string, unknown>, kind: KeyKind, ref: string | undefined, log: (line: string) => void = () => {}): FacilitatorError {
  const code = typeof body['error'] === 'string' ? body['error'] : '';
  const message = typeof body['message'] === 'string' ? body['message'] : '';
  if (status === 401) {
    if (kind === 'operator') return new FacilitatorError(401, 'session_ended', 'Your demo session ended. Start a new one.');
    if (kind === 'seller') {
      log('[facilitator] the seller key (WEB_SELLER_API_KEY) was refused with 401; check the configuration');
      return new FacilitatorError(503, 'seller_unavailable', "The seller console isn't available right now.");
    }
    log('[facilitator] the admin key (FACILITATOR_ADMIN_KEY) was refused with 401; check the configuration');
    return new FacilitatorError(502, 'upstream_error', UPSTREAM_MESSAGE, { ref });
  }
  if (status === 409) return new FacilitatorError(409, code || 'conflict', message, { body });
  if (status === 502 && code === 'paypal_unavailable') return new FacilitatorError(502, code, "PayPal didn't answer. Try again in a moment.");
  if (status === 400 && code === 'validation_failed') {
    const issues = issuesSchema.safeParse(body['issues']);
    return new FacilitatorError(400, code, message || 'The request is invalid', { issues: issues.success ? issues.data : [] });
  }
  if (status === 404) return new FacilitatorError(404, 'not_found', message || 'Not found');
  if (status === 429) return new FacilitatorError(429, code || 'too_many_requests', message || 'Too many requests');
  return new FacilitatorError(502, 'upstream_error', UPSTREAM_MESSAGE, { ref });
}

export interface FacilitatorOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}

type Query = Record<string, string | number | undefined>;

/** The facilitator over HTTP. Each call names its key and the key's kind, for the error mapping. */
export class FacilitatorClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(options: FacilitatorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  url(path: string, query: Query = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    return url.toString();
  }

  async request<S extends z.ZodType>(
    schema: S,
    options: { method: string; path: string; key: string; kind: KeyKind; query?: Query; body?: unknown },
  ): Promise<z.output<S>> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url(options.path, options.query), {
        method: options.method,
        headers: {
          Authorization: `Bearer ${options.key}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: 'no-store',
      });
    } catch {
      this.log(`[facilitator] ${options.method} ${options.path} failed: the facilitator could not be reached`);
      throw new FacilitatorError(502, 'upstream_error', UPSTREAM_MESSAGE);
    }
    const ref = res.headers.get('x-request-id') ?? undefined;
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text === '' ? {} : JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (res.status < 200 || res.status >= 300) {
      const error = mapError(res.status, body, options.kind, ref, this.log);
      if (error.code === 'upstream_error') this.log(`[facilitator] ${options.method} ${options.path} answered ${res.status} (ref ${ref ?? '-'})`);
      throw error;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      this.log(`[facilitator] ${options.method} ${options.path}: unexpected response shape (ref ${ref ?? '-'})`);
      throw new FacilitatorError(502, 'upstream_error', UPSTREAM_MESSAGE, { ref });
    }
    return parsed.data;
  }

  operator(key: string) {
    const call = <S extends z.ZodType>(schema: S, method: string, path: string, extra: { query?: Query; body?: unknown } = {}) =>
      this.request(schema, { method, path, key, kind: 'operator', ...extra });
    return {
      get: () => call(operatorViewSchema, 'GET', '/v1/operator'),
      putCaps: (caps: { perCall: number; daily: number; unsettled: number; total: number | null }) =>
        call(z.object({ caps: capsSchema }), 'PUT', '/v1/operator/caps', { body: caps }),
      link: () => call(z.object({ approveUrl: z.string(), expiresAt: unix }), 'POST', '/v1/operator/wallet/link'),
      refresh: () => call(z.object({ wallet: walletSchema }), 'POST', '/v1/operator/wallet/refresh'),
      unlink: () => call(z.object({ wallet: walletSchema }), 'POST', '/v1/operator/wallet/unlink'),
      agents: () => call(z.object({ agents: z.array(agentWithUsageSchema) }), 'GET', '/v1/agents'),
      agent: (id: string) => call(z.object({ agent: agentWithUsageSchema }), 'GET', `/v1/agents/${encodeURIComponent(id)}`),
      createAgent: (body: { name: string; publicKeyX: string }) => call(z.object({ agent: agentSchema }), 'POST', '/v1/agents', { body }),
      createClaim: (body: { name: string; sellerUrl: string }) =>
        call(z.object({ claim: claimSchema }), 'POST', '/v1/agents/claims', { body }),
      patchAgent: (id: string, body: { status: 'active' | 'paused' }) =>
        call(z.object({ agent: agentWithUsageSchema }), 'PATCH', `/v1/agents/${encodeURIComponent(id)}`, { body }),
      commitments: (query: { since?: number; before?: number; limit?: number; agentId?: string }) =>
        call(z.object({ commitments: z.array(commitmentSchema) }), 'GET', '/v1/commitments', { query }),
      settlements: (query: { before?: number; limit?: number }) =>
        call(z.object({ settlements: z.array(settlementSchema) }), 'GET', '/v1/settlements', { query }),
      settlement: (id: string) => call(z.object({ settlement: settlementDetailSchema }), 'GET', `/v1/settlements/${encodeURIComponent(id)}`),
      settle: () => call(z.object({ settlement: settlementSchema }), 'POST', '/v1/settlements'),
    };
  }

  seller(key: string) {
    const call = <S extends z.ZodType>(schema: S, method: string, path: string, extra: { query?: Query } = {}) =>
      this.request(schema, { method, path, key, kind: 'seller', ...extra });
    return {
      get: () => call(sellerViewSchema, 'GET', '/v1/seller'),
      commitments: (query: { since?: number; before?: number; limit?: number }) =>
        call(z.object({ commitments: z.array(sellerCommitmentSchema) }), 'GET', '/v1/seller/commitments', { query }),
      settlements: (query: { before?: number; limit?: number }) =>
        call(z.object({ settlements: z.array(sellerSettlementSchema) }), 'GET', '/v1/seller/settlements', { query }),
    };
  }

  admin(key: string) {
    return {
      createDemoOperator: () => this.request(demoOperatorSchema, { method: 'POST', path: '/v1/admin/demo-operators', key, kind: 'admin', body: {} }),
    };
  }
}

export type OperatorApi = ReturnType<FacilitatorClient['operator']>;
export type SellerApi = ReturnType<FacilitatorClient['seller']>;
