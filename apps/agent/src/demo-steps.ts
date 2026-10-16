/**
 * The demo command's decisions (design spec §9 steps 3, 7 and 8), as small functions over an
 * `api(method, path, body?)` function. Nothing here imports the facilitator: the few response fields
 * read are declared below.
 */

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Calls the facilitator with the run's operator key. */
export type Api = (method: string, path: string, body?: unknown) => Promise<ApiResponse>;

/** A demo failure; the message is printed after `RESULT: FAIL.` and is safe to show. */
export class DemoFail extends Error {
  override readonly name = 'DemoFail';
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record).filter((r): r is Record<string, unknown> => r !== undefined) : [];

function httpProblem(what: string, res: ApiResponse): DemoFail {
  return new DemoFail(`${what} failed (HTTP ${res.status}${str(res.body['error']) ? `, ${str(res.body['error'])}` : ''}).`);
}

export interface DemoAgent {
  id: string;
  status: string;
}

/**
 * Ensures an agent with this key exists for the operator (§9 step 3). A 409 `agent_key_exists`
 * carries no id, so the agent is found by `kid`; none means another operator owns the key.
 */
export async function ensureAgent(api: Api, input: { name: string; publicKeyX: string; kid: string }): Promise<DemoAgent> {
  const created = await api('POST', '/v1/agents', { name: input.name, publicKeyX: input.publicKeyX });
  if (created.status === 201) {
    const agent = record(created.body['agent']);
    const id = str(agent?.['id']);
    if (!id) throw new DemoFail('Creating the agent returned no id.');
    return { id, status: str(agent?.['status']) ?? 'active' };
  }
  if (created.status !== 409 || created.body['error'] !== 'agent_key_exists') throw httpProblem('Creating the agent', created);
  const listed = await api('GET', '/v1/agents');
  if (listed.status !== 200) throw httpProblem('Listing the agents', listed);
  const agent = list(listed.body['agents']).find((a) => a['kid'] === input.kid);
  const id = str(agent?.['id']);
  if (!agent || !id) throw new DemoFail('The agent key is registered to another operator.');
  return { id, status: str(agent['status']) ?? 'active' };
}

export interface PaidCall {
  commitmentId: string | null;
  amountCents: number;
}

interface CommitmentRow {
  id: string;
  amount: number;
  state: string;
  settlementId: string | null;
}

function commitmentRows(body: Record<string, unknown>): CommitmentRow[] {
  return list(body['commitments']).flatMap((c) => {
    const id = str(c['id']);
    const amount = num(c['amount']);
    if (id === undefined || amount === undefined) return [];
    return [{ id, amount, state: str(c['state']) ?? '', settlementId: str(c['settlementId']) ?? null }];
  });
}

async function runCommitments(api: Api, agentId: string, sinceSeconds: number): Promise<CommitmentRow[]> {
  const res = await api('GET', `/v1/commitments?agentId=${encodeURIComponent(agentId)}&since=${sinceSeconds}&limit=500`);
  if (res.status !== 200) throw httpProblem('Listing the commitments', res);
  return commitmentRows(res.body);
}

export interface LedgerMatch {
  count: number;
  totalCents: number;
}

/**
 * The ledger check (§9 step 7): the facilitator's commitments for this agent since the run start
 * must be exactly the report's commitment ids, each with the `paid` event's amount.
 */
export async function checkLedger(api: Api, input: { agentId: string; sinceSeconds: number; paid: PaidCall[] }): Promise<LedgerMatch> {
  const rows = await runCommitments(api, input.agentId, input.sinceSeconds);
  const expected = new Map<string, number>();
  for (const call of input.paid) if (call.commitmentId !== null) expected.set(call.commitmentId, call.amountCents);
  const missing = [...expected.keys()].filter((id) => !rows.some((r) => r.id === id));
  const extra = rows.filter((r) => !expected.has(r.id)).map((r) => r.id);
  if (missing.length > 0 || extra.length > 0) {
    throw new DemoFail(
      `Ledger mismatch: ${missing.length} reported commitment(s) not in the ledger${missing.length ? ` (${missing.join(', ')})` : ''}, ` +
        `${extra.length} ledger commitment(s) not in the report${extra.length ? ` (${extra.join(', ')})` : ''}.`,
    );
  }
  for (const row of rows) {
    if (row.amount !== expected.get(row.id)) {
      throw new DemoFail(`Ledger mismatch: commitment ${row.id} records ${row.amount} cents, the agent reported ${expected.get(row.id)}.`);
    }
  }
  return { count: rows.length, totalCents: rows.reduce((sum, r) => sum + r.amount, 0) };
}

export type SettlementDecision = { settle: true } | { settle: false; reason: string };

/**
 * Whether step 8 runs (§9): `--no-settle` not set, at least one paid call, and the wallet `active`
 * as known after step 4. The status is not re-read: a wallet revoked after the run must reach
 * `POST /v1/settlements` and its 409 `wallet_not_active`, which fails the demo.
 */
export function settlementDecision(input: { settleFlag: boolean; paidCalls: number; walletStatusAfterLink: string }): SettlementDecision {
  if (!input.settleFlag) return { settle: false, reason: 'Settlement skipped (--no-settle).' };
  if (input.paidCalls === 0) return { settle: false, reason: 'Settlement skipped: the run made no paid calls.' };
  if (input.walletStatusAfterLink !== 'active') {
    return { settle: false, reason: `Settlement skipped: the wallet is ${input.walletStatusAfterLink}.` };
  }
  return { settle: true };
}

export interface SettlementSummary {
  id: string;
  amountCents: number;
  calls: number;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
}

export interface SettleDeps {
  api: Api;
  sleep(ms: number): Promise<void>;
  /** Unix milliseconds, for the deadlines. */
  now(): number;
}

export interface SettleInput {
  agentId: string;
  sinceSeconds: number;
  commitmentIds: string[];
}

export const SETTLE_TIMING = { inProgressWaitMs: 60_000, settledWaitMs: 90_000, pollMs: 3_000 } as const;

function failedSettlement(s: Record<string, unknown>): DemoFail {
  return new DemoFail(
    `Settlement ${str(s['id']) ?? '?'} is ${str(s['status']) ?? '?'}: ${str(s['failureCode']) ?? 'no code'}` +
      `${str(s['failureReason']) ? ` (${str(s['failureReason'])})` : ''}.`,
  );
}

async function waitForNoPending(deps: SettleDeps): Promise<void> {
  const deadline = deps.now() + SETTLE_TIMING.inProgressWaitMs;
  for (;;) {
    const res = await deps.api('GET', '/v1/settlements?limit=50');
    if (res.status !== 200) throw httpProblem('Listing the settlements', res);
    if (!list(res.body['settlements']).some((s) => s['status'] === 'pending')) return;
    if (deps.now() >= deadline) throw new DemoFail('A settlement already in progress did not finish within 60 s.');
    await deps.sleep(SETTLE_TIMING.pollMs);
  }
}

/** One `POST /v1/settlements` and its outcome (§9 step 8). Returns 'retry' for `settlement_in_progress`. */
async function trigger(deps: SettleDeps): Promise<'ok' | 'retry'> {
  const res = await deps.api('POST', '/v1/settlements');
  if (res.status === 201) {
    const s = record(res.body['settlement']) ?? {};
    const status = str(s['status']);
    if (status === 'completed' || status === 'pending') return 'ok';
    throw failedSettlement(s);
  }
  if (res.status === 409) {
    const code = str(res.body['error']);
    if (code === 'nothing_to_settle') return 'ok';
    if (code === 'settlement_in_progress') return 'retry';
    if (code === 'wallet_not_active') throw new DemoFail('The PayPal wallet is not active (wallet_not_active); it was stopped after the run.');
  }
  throw httpProblem('Starting the settlement', res);
}

/**
 * Settles the run (§9 step 8): triggers a settlement, waits until every run commitment is settled,
 * and checks each settlement that covers them.
 */
export async function settleRun(deps: SettleDeps, input: SettleInput): Promise<SettlementSummary[]> {
  if ((await trigger(deps)) === 'retry') {
    await waitForNoPending(deps);
    if ((await trigger(deps)) === 'retry') throw new DemoFail('A settlement is still in progress after waiting.');
  }

  const deadline = deps.now() + SETTLE_TIMING.settledWaitMs;
  const ids = new Set(input.commitmentIds);
  let rows: CommitmentRow[];
  for (;;) {
    rows = (await runCommitments(deps.api, input.agentId, input.sinceSeconds)).filter((r) => ids.has(r.id));
    const lost = rows.find((r) => r.state === 'uncollectable');
    if (lost) throw new DemoFail(`Commitment ${lost.id} is uncollectable.`);
    for (const settlementId of new Set(rows.map((r) => r.settlementId).filter((id): id is string => id !== null))) {
      const res = await deps.api('GET', `/v1/settlements/${encodeURIComponent(settlementId)}`);
      const s = record(res.body['settlement']);
      if (s && (s['status'] === 'failed' || s['status'] === 'needs_review')) throw failedSettlement(s);
    }
    if (rows.length === ids.size && rows.every((r) => r.state === 'settled')) break;
    if (deps.now() >= deadline) throw new DemoFail('The run commitments were not settled within 90 s.');
    await deps.sleep(SETTLE_TIMING.pollMs);
  }

  const summaries: SettlementSummary[] = [];
  for (const settlementId of new Set(rows.map((r) => r.settlementId).filter((id): id is string => id !== null))) {
    const res = await deps.api('GET', `/v1/settlements/${encodeURIComponent(settlementId)}`);
    if (res.status !== 200) throw httpProblem(`Reading settlement ${settlementId}`, res);
    const s = record(res.body['settlement']) ?? {};
    const covered = commitmentRows(s);
    const amount = num(s['amount']);
    const sum = covered.reduce((total, c) => total + c.amount, 0);
    if (s['status'] !== 'completed') throw failedSettlement(s);
    if (s['captureStatus'] !== 'COMPLETED') throw new DemoFail(`Settlement ${settlementId}: the PayPal capture is ${str(s['captureStatus']) ?? 'missing'}.`);
    if (amount !== sum) throw new DemoFail(`Settlement ${settlementId}: amount ${String(amount)} is not the sum of its commitments (${sum}).`);
    const runIds = rows.filter((r) => r.settlementId === settlementId).map((r) => r.id);
    if (!runIds.every((id) => covered.some((c) => c.id === id))) {
      throw new DemoFail(`Settlement ${settlementId} does not list all the run commitments it covers.`);
    }
    summaries.push({
      id: settlementId,
      amountCents: sum,
      calls: covered.length,
      paypalOrderId: str(s['paypalOrderId']) ?? null,
      paypalCaptureId: str(s['paypalCaptureId']) ?? null,
    });
  }
  return summaries;
}
