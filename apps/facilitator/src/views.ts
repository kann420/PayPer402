/** Row-to-API mappers and read models shared by the routes. */
import { exceededCap, utcDayStart } from '@payper402/scheme-paypal';
import { hmacHex } from './crypto';
import type { Db } from './db/connection';
import type { AgentRow, CommitmentRow, OperatorRow, SettlementRow, WalletRow } from './db/rows';
import { capsOf, snapshotSync } from './stores';

/** Path and query of a resource URL; empty when it is not a URL. */
export function pathOf(resourceUrl: string): string {
  try {
    const url = new URL(resourceUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

/** Opaque per-agent reference for sellers: first 8 hex chars of `HMAC(API_KEY_PEPPER, agentId)`. */
export function agentRef(pepper: string, agentId: string): string {
  return hmacHex(pepper, agentId).slice(0, 8);
}

export function keyFingerprint(kid: string): string {
  return `ed25519:${kid.slice(0, 6)}${kid.slice(-4)}`;
}

export interface WalletView {
  status: string;
  payerEmailMasked: string | null;
  linkedAt: number | null;
  stoppedAt: number | null;
  lastChargeAt: number | null;
  lastChargeAmount: number | null;
  lastChargeStatus: string | null;
  linkError: string | null;
}

export function walletView(db: Db, wallet: WalletRow): WalletView {
  const last = db
    .prepare('SELECT created_at, amount, status FROM settlements WHERE operator_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(wallet.operator_id) as { created_at: number; amount: number; status: string } | undefined;
  return {
    status: wallet.status,
    payerEmailMasked: wallet.payer_email_masked,
    linkedAt: wallet.linked_at,
    stoppedAt: wallet.stopped_at,
    lastChargeAt: last?.created_at ?? null,
    lastChargeAmount: last?.amount ?? null,
    lastChargeStatus: last?.status ?? null,
    linkError: wallet.link_error,
  };
}

export function capsView(operator: OperatorRow) {
  return capsOf(operator);
}

export interface CommitmentView {
  id: string;
  recordedAt: number;
  agentId: string;
  agentName: string;
  payTo: string;
  resourceUrl: string;
  path: string;
  amount: number;
  maxAmount: number;
  state: string;
  settlementId: string | null;
}

export function commitmentView(row: CommitmentRow & { agent_name: string }): CommitmentView {
  return {
    id: row.id,
    recordedAt: row.recorded_at,
    agentId: row.agent_id,
    agentName: row.agent_name,
    payTo: row.pay_to,
    resourceUrl: row.resource_url,
    path: pathOf(row.resource_url),
    amount: row.amount,
    maxAmount: row.max_amount,
    state: row.state,
    settlementId: row.settlement_id,
  };
}

export function sellerCommitmentView(pepper: string, row: CommitmentRow) {
  return {
    id: row.id,
    recordedAt: row.recorded_at,
    agentRef: agentRef(pepper, row.agent_id),
    payTo: row.pay_to,
    resourceUrl: row.resource_url,
    path: pathOf(row.resource_url),
    amount: row.amount,
    maxAmount: row.max_amount,
    state: row.state,
    settlementId: row.settlement_id,
  };
}

export function settlementView(row: SettlementRow) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    trigger: row.trigger,
    status: row.status,
    amount: row.amount,
    callsCount: row.calls_count,
    paypalOrderId: row.paypal_order_id,
    paypalCaptureId: row.paypal_capture_id,
    captureStatus: row.capture_status,
    fee: row.fee,
    net: row.net,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

/** `feeShare = round(fee × sellerAmount / amount)`; null until the fee is known. */
export function feeShare(fee: number | null, sellerAmount: number, amount: number): number | null {
  if (fee === null || amount <= 0) return null;
  return Math.round((fee * sellerAmount) / amount);
}

export interface AgentView {
  id: string;
  name: string;
  kid: string;
  keyFingerprint: string;
  status: string;
  createdAt: number;
}

export function agentView(row: AgentRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    kid: row.kid,
    keyFingerprint: keyFingerprint(row.kid),
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Agent with usage, the derived `blocked` flag and its `blockReason` (design spec §7.2). */
export function agentWithUsage(db: Db, row: AgentRow, operator: OperatorRow, walletStatus: string, now: number) {
  const dayStart = utcDayStart(now);
  const usage = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN recorded_at >= @dayStart AND recorded_at < @dayEnd THEN amount ELSE 0 END), 0) AS spentToday,
         COALESCE(SUM(amount), 0) AS spentTotal,
         COALESCE(SUM(CASE WHEN recorded_at >= @dayStart AND recorded_at < @dayEnd THEN 1 ELSE 0 END), 0) AS callsToday,
         MAX(recorded_at) AS lastCallAt
       FROM commitments WHERE agent_id = @agentId`,
    )
    .get({ agentId: row.id, dayStart, dayEnd: dayStart + 86_400 }) as {
    spentToday: number;
    spentTotal: number;
    callsToday: number;
    lastCallAt: number | null;
  };
  const blockReason = operatorBlockReason(db, operator, walletStatus, now);
  return { ...agentView(row), ...usage, blocked: blockReason !== null, blockReason };
}

export interface OperatorUsage {
  spentToday: number;
  notYetCharged: number;
  spentTotal: number;
  notYetChargedCalls: number;
  chargeable: number;
  chargeableCalls: number;
  notCollected: number;
  notCollectedCalls: number;
}

/** The operator's spend figures, as in `GET /v1/operator` `usage` (design spec §7.2). */
export function operatorUsage(db: Db, operatorId: string, now: number): OperatorUsage {
  const snapshot = snapshotSync(db, operatorId, now);
  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state IN ('unsettled', 'settling') THEN 1 ELSE 0 END), 0) AS notYetChargedCalls,
         COALESCE(SUM(CASE WHEN state = 'unsettled' THEN amount ELSE 0 END), 0) AS chargeable,
         COALESCE(SUM(CASE WHEN state = 'unsettled' THEN 1 ELSE 0 END), 0) AS chargeableCalls,
         COALESCE(SUM(CASE WHEN state = 'uncollectable' THEN amount ELSE 0 END), 0) AS notCollected,
         COALESCE(SUM(CASE WHEN state = 'uncollectable' THEN 1 ELSE 0 END), 0) AS notCollectedCalls
       FROM commitments WHERE operator_id = ?`,
    )
    .get(operatorId) as {
    notYetChargedCalls: number;
    chargeable: number;
    chargeableCalls: number;
    notCollected: number;
    notCollectedCalls: number;
  };
  return {
    spentToday: snapshot.spentToday,
    notYetCharged: snapshot.unsettled,
    spentTotal: snapshot.spentTotal,
    notYetChargedCalls: counts.notYetChargedCalls,
    chargeable: counts.chargeable,
    chargeableCalls: counts.chargeableCalls,
    notCollected: counts.notCollected,
    notCollectedCalls: counts.notCollectedCalls,
  };
}

/** Why the operator's agents are refused right now (web-app spec §5.3), or null. */
export type BlockReason = 'wallet_not_active' | 'daily' | 'unsettled' | 'total';

/**
 * The block reason: `wallet_not_active` when the wallet is not active, otherwise the cap a
 * max-priced call would exceed. `perCall` cannot occur (the amount checked is the per-call cap
 * itself) and maps to null. Neither this nor `blocked` looks at an agent's own status.
 */
export function operatorBlockReason(db: Db, operator: OperatorRow, walletStatus: string, now: number): BlockReason | null {
  if (walletStatus !== 'active') return 'wallet_not_active';
  const caps = capsOf(operator);
  const cap = exceededCap(caps.perCall, snapshotSync(db, operator.id, now), caps);
  return cap === 'daily' || cap === 'unsettled' || cap === 'total' ? cap : null;
}

/** True when the wallet is not active or a max-priced call would exceed a cap right now. */
export function operatorBlocked(db: Db, operator: OperatorRow, walletStatus: string, now: number): boolean {
  return operatorBlockReason(db, operator, walletStatus, now) !== null;
}
