import type { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ASSET, PAYPAL_SANDBOX_NETWORK, SCHEME, centsToUsdString, tryParseCentsString } from '@payper402/scheme-paypal';
import type { Budget, Reservation } from './budget';
import type { CatalogService, ParamIssue } from './catalog';
import {
  BLOCKING_REFUSALS,
  FAILURE_NOTES,
  REFUSAL_NOTES,
  isBindingCode,
  refusalForBindingCode,
  type AgentEvent,
  type RefusalCode,
} from './events';

/** Timeout of the probe and of the paid request (design spec §4.3). */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Largest response body returned to the caller (design spec §4.3 step 7). */
export const MAX_BODY_BYTES = 64 * 1024;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the session stamps its `at`. */
export type EventInput = DistributiveOmit<AgentEvent, 'at'>;

export type CallErrorKind = 'unknown_service' | 'invalid_params' | 'payments_blocked' | 'refused' | 'failed';

/** The outcome of `session.call`, turned into a tool result by the tool core. */
export type CallOutcome =
  | { ok: true; serviceId: string; paidCents: number; commitmentId: string | null; data: unknown }
  | { ok: false; error: CallErrorKind; code?: string; message: string; issues?: ParamIssue[] };

/** What one paid call needs from its session. */
export interface PaidCallContext {
  callId: string;
  service: CatalogService;
  url: URL;
  params: Record<string, string | number>;
  reason: string;
  payTo: string;
  budget: Budget;
  /** This call's client and its HTTP wrapper, built before the probe (design spec §4.3 step 1). */
  client: x402Client;
  http: x402HTTPClient;
  fetch: typeof fetch;
  emit(event: EventInput): void;
  /** Sets the session to blocked (design spec §4.5). */
  block(): void;
}

function requestInit(ctx: PaidCallContext, headers: Record<string, string> = {}): { url: URL; init: RequestInit } {
  const url = new URL(ctx.url);
  if (ctx.service.method === 'GET') {
    for (const [name, value] of Object.entries(ctx.params)) url.searchParams.set(name, String(value));
    return { url, init: { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } };
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(ctx.params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  };
}

/** Reads at most 64 KB. JSON is parsed; other types are kept as text. A larger body is replaced. */
export async function readBody(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { error: 'response_too_large' };
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** The seller's `error` code from an error body, when it is a short snake_case string. */
async function sellerErrorCode(res: Response): Promise<string | undefined> {
  const body = await readBody(res).catch(() => undefined);
  const code = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['error'] : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

function statusNote(status: number, code: string | undefined): string {
  return `The service answered HTTP ${status}${code === undefined ? '' : ` (${code})`}`;
}

function tryDecode<T>(decode: () => T): T | undefined {
  try {
    return decode();
  } catch {
    return undefined;
  }
}

/**
 * Runs design spec §4.3 steps 2 to 7 for one call: local pre-check, probe, decide, sign, pay, and
 * read the body. Never throws; every failure is an event plus an error outcome.
 */
export async function runPaidCall(ctx: PaidCallContext): Promise<CallOutcome> {
  const { service, budget, callId } = ctx;
  const ids = { callId, serviceId: service.id, serviceName: service.name };

  const failed = (note: string, charged: 'no' | 'unknown'): CallOutcome => {
    ctx.emit({ type: 'failed', ...ids, note, charged });
    return { ok: false, error: 'failed', message: note };
  };
  const refused = (code: RefusalCode, by: 'agent' | 'facilitator', detail?: string): CallOutcome => {
    const note = REFUSAL_NOTES[code];
    ctx.emit({ type: 'refused', ...ids, code, by, note, ...(detail === undefined ? {} : { detail }) });
    if (by === 'facilitator' && BLOCKING_REFUSALS.has(code)) ctx.block();
    return { ok: false, error: 'refused', code, message: note };
  };

  // Step 2: local pre-check from the catalog price. No request is made.
  if (service.priceCents > budget.maxPerCallCents) return refused('over_per_call_limit', 'agent');
  if (service.priceCents > budget.remainingCents) return refused('over_budget', 'agent');

  // Step 3: probe.
  const probeRequest = requestInit(ctx);
  let probe: Response;
  try {
    probe = await ctx.fetch(probeRequest.url, probeRequest.init);
  } catch {
    return failed(FAILURE_NOTES.unreachable, 'no');
  }
  if (probe.status >= 200 && probe.status < 300) {
    const data = await readBody(probe).catch(() => ({ error: 'response_unreadable' }));
    return { ok: true, serviceId: service.id, paidCents: 0, commitmentId: null, data };
  }
  if (probe.status !== 402) {
    return failed(statusNote(probe.status, await sellerErrorCode(probe)), 'no');
  }
  const paymentRequired = tryDecode<PaymentRequired>(() => ctx.http.getPaymentRequiredResponse((name) => probe.headers.get(name)));
  await discard(probe);
  if (!paymentRequired || !Array.isArray(paymentRequired.accepts)) return failed(FAILURE_NOTES.unreadable402, 'no');
  const requirement = paymentRequired.accepts.find(
    (r: PaymentRequirements) => r.scheme === SCHEME && r.network === PAYPAL_SANDBOX_NETWORK && r.asset === ASSET && r.payTo === ctx.payTo,
  );
  if (!requirement) return refused('payee_mismatch', 'agent');
  const priceCents = tryParseCentsString(requirement.amount);
  if (priceCents === undefined) return failed(FAILURE_NOTES.invalidAmount, 'no');
  ctx.emit({ type: 'discovered_price', ...ids, priceCents, catalogPriceCents: service.priceCents });

  // Step 4: decide, synchronously, with no await between the checks and the reservation.
  if (priceCents > service.priceCents) return refused('price_changed', 'agent');
  if (priceCents > budget.maxPerCallCents) return refused('over_per_call_limit', 'agent');
  const reservation = budget.reserve(priceCents);
  if (!reservation) return refused('over_budget', 'agent');
  ctx.emit({ type: 'decided', ...ids, priceCents, note: ctx.reason, remainingCents: budget.remainingCents });

  // Step 5: sign, with the policy and the spend control set now that the price is known.
  ctx.client.registerPolicy((_version, requirements) =>
    requirements.filter(
      (r) =>
        r.scheme === requirement.scheme &&
        r.network === requirement.network &&
        r.asset === requirement.asset &&
        r.payTo === requirement.payTo &&
        r.amount === requirement.amount,
    ),
  );
  ctx.client.setSpendControls({ maxAmountPerPayment: `$${centsToUsdString(priceCents)}` });
  let payload: PaymentPayload;
  try {
    payload = await ctx.http.createPaymentPayload(paymentRequired);
  } catch {
    budget.release(reservation);
    return failed(FAILURE_NOTES.signingFailed, 'no');
  }
  if (payload.accepted.amount !== requirement.amount || payload.accepted.payTo !== ctx.payTo) {
    budget.release(reservation);
    return failed(FAILURE_NOTES.payloadMismatch, 'no');
  }

  // Step 6: pay with the same request plus the payment header.
  const paidRequest = requestInit(ctx, ctx.http.encodePaymentSignatureHeader(payload));
  let paid: Response;
  try {
    paid = await ctx.fetch(paidRequest.url, paidRequest.init);
  } catch {
    budget.markUncertain(reservation);
    return failed(FAILURE_NOTES.unknownOutcome, 'unknown');
  }
  if (paid.status >= 200 && paid.status < 300) return paidOutcome(ctx, paid, reservation, ids);
  if (paid.status === 402) {
    const settle = tryDecode<SettleResponse>(() => ctx.http.getPaymentSettleResponse((name) => paid.headers.get(name)));
    const required = tryDecode<PaymentRequired>(() => ctx.http.getPaymentRequiredResponse((name) => paid.headers.get(name)));
    await discard(paid);
    if (settle && settle.success === false) {
      if (isBindingCode(settle.errorReason)) {
        budget.release(reservation);
        const refusal = refusalForBindingCode(settle.errorReason);
        return refused(refusal.code, 'facilitator', refusal.detail);
      }
      // A settle call that failed in transit: the facilitator may have recorded the commitment.
      budget.markUncertain(reservation);
      return failed(FAILURE_NOTES.unknownOutcome, 'unknown');
    }
    if (required) {
      budget.release(reservation);
      if (isBindingCode(required.error)) {
        const refusal = refusalForBindingCode(required.error);
        return refused(refusal.code, 'facilitator', refusal.detail);
      }
      return failed(FAILURE_NOTES.notCompleted, 'no');
    }
    budget.markUncertain(reservation);
    return failed(FAILURE_NOTES.unknownOutcome, 'unknown');
  }
  if (paid.status === 502) {
    // The middleware could not read the facilitator's answer, at verify or at settle.
    await discard(paid);
    budget.markUncertain(reservation);
    return failed(FAILURE_NOTES.unknownOutcome, 'unknown');
  }
  // The middleware settles only responses below 400, so nothing was charged.
  const code = await sellerErrorCode(paid);
  budget.release(reservation);
  return failed(statusNote(paid.status, code), 'no');
}

async function paidOutcome(
  ctx: PaidCallContext,
  res: Response,
  reservation: Reservation,
  ids: { callId: string; serviceId: string; serviceName: string },
): Promise<CallOutcome> {
  const settle = tryDecode<SettleResponse>(() => ctx.http.getPaymentSettleResponse((name) => res.headers.get(name)));
  let actualCents = reservation.amountCents;
  let commitmentId: string | null = null;
  if (settle && settle.success === true) {
    actualCents = tryParseCentsString(settle.amount) ?? reservation.amountCents;
    commitmentId = typeof settle.transaction === 'string' && settle.transaction !== '' ? settle.transaction : null;
  }
  // A 2xx means the handler ran and the middleware settled, so the money counts as spent.
  const { committedCents, overReported } = ctx.budget.commit(reservation, actualCents);
  ctx.emit({
    type: 'paid',
    ...ids,
    amountCents: committedCents,
    commitmentId,
    httpStatus: res.status,
    spentCents: ctx.budget.spentCents,
    remainingCents: ctx.budget.remainingCents,
  });
  if (overReported) ctx.emit({ type: 'failed', ...ids, note: FAILURE_NOTES.overReported, charged: 'no' });
  // Step 7: the body is seller data, returned as data.
  const data = await readBody(res).catch(() => ({ error: 'response_unreadable' }));
  return { ok: true, serviceId: ids.serviceId, paidCents: committedCents, commitmentId, data };
}
