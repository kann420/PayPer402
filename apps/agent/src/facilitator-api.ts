/**
 * The two facilitator calls of the `payper402` command (operator-cli.md §3.4, §4): redeeming a
 * claim code and reading the agent-signed status. Neither result carries a secret.
 */
import type { KeyObject } from 'node:crypto';
import { signAgentRequest } from '@payper402/scheme-paypal';
import { z } from 'zod';

export const STATUS_PATH = '/v1/agent/status';
export const DEFAULT_TIMEOUT_MS = 15_000;

const unix = z.number().int();
const cents = z.number().int();

const redeemSchema = z.looseObject({
  agent: z.looseObject({ id: z.string(), name: z.string(), kid: z.string(), keyFingerprint: z.string(), status: z.string(), createdAt: unix }),
  operator: z.looseObject({ name: z.string() }),
  sellerUrl: z.string().nullable(),
});
export type RedeemBody = z.output<typeof redeemSchema>;

const statusSchema = z.looseObject({
  agent: z.looseObject({
    id: z.string(),
    name: z.string(),
    keyFingerprint: z.string(),
    status: z.string(),
    createdAt: unix,
    spentToday: cents,
    spentTotal: cents,
    callsToday: z.number().int(),
    lastCallAt: unix.nullable(),
  }),
  operator: z.looseObject({ name: z.string() }),
  wallet: z.looseObject({
    status: z.string(),
    stoppedAt: unix.nullable(),
    lastChargeAt: unix.nullable(),
    lastChargeAmount: cents.nullable(),
    lastChargeStatus: z.string().nullable(),
  }),
  // `total` is absent when the operator has no total limit (operator-cli.md §4.4).
  caps: z.looseObject({ perCall: cents, daily: cents, unsettled: cents, total: cents.optional() }),
  usage: z.looseObject({ spentToday: cents, notYetCharged: cents, notYetChargedCalls: z.number().int(), spentTotal: cents }),
  remainingToday: cents,
  blocked: z.boolean(),
  blockReason: z.string().nullable(),
});
export type AgentStatus = z.output<typeof statusSchema>;

/** A discriminated result: the validated body, an HTTP answer that was not a success, or no answer. */
export type ApiResult<T> =
  | { ok: true; body: T }
  | { ok: false; kind: 'http'; status: number; error: string; issuePaths: string[] }
  | { ok: false; kind: 'network' };

async function call<S extends z.ZodType>(
  schema: S,
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ApiResult<z.output<S>>> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch {
    return { ok: false, kind: 'network' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status < 200 || res.status >= 300) {
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const issues = Array.isArray(record['issues']) ? (record['issues'] as unknown[]) : [];
    return {
      ok: false,
      kind: 'http',
      status: res.status,
      error: typeof record['error'] === 'string' ? record['error'] : '',
      issuePaths: issues.flatMap((issue) =>
        typeof issue === 'object' && issue !== null && typeof (issue as Record<string, unknown>)['path'] === 'string'
          ? [(issue as Record<string, string>)['path'] as string]
          : [],
      ),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, kind: 'http', status: res.status, error: 'bad_response', issuePaths: [] };
  return { ok: true, body: parsed.data };
}

/** `POST <api>/v1/claims/redeem` with the claim code and the new agent's public key. */
export function redeemClaim(options: {
  api: string;
  code: string;
  publicKeyX: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<ApiResult<RedeemBody>> {
  return call(
    redeemSchema,
    `${options.api}/v1/claims/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: options.code, publicKeyX: options.publicKeyX }),
    },
    options.fetch ?? fetch,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

/** `GET <api>/v1/agent/status`, signed with the agent's key at `now()` seconds. */
export function getAgentStatus(options: {
  api: string;
  privateKey: KeyObject;
  kid: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<ApiResult<AgentStatus>> {
  const iat = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  const authorization = signAgentRequest({ privateKey: options.privateKey, kid: options.kid, iat, method: 'GET', path: STATUS_PATH });
  return call(
    statusSchema,
    `${options.api}${STATUS_PATH}`,
    { method: 'GET', headers: { Authorization: authorization } },
    options.fetch ?? fetch,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}
