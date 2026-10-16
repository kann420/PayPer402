import { utcDayStart } from '@payper402/scheme-paypal';
import {
  PayPalApiError,
  classifyPayPalError,
  mapCapture,
  type ChargeResult,
} from '@payper402/paypal-client';
import { recordAudit } from '../audit';
import { randomId } from '../crypto';
import type { OperatorRow, SettlementRow, SettlementTrigger, WalletRow } from '../db/rows';
import { conflict } from '../http';
import { errorFields, errorMessage } from '../logger';
import { BackgroundWork, readWallet, type ServiceContext } from './context';
import {
  deleteVaultToken,
  emitWallet,
  finishUnlink,
  relinkOutcomeTx,
  revokeWalletTx,
  unlinkDeclinedTx,
} from './wallet-state';

/** Backoff after transient errors, by attempt number (design spec §9.3). */
export const RETRY_DELAYS_SECONDS = [30, 120, 600] as const;
/** A pending settlement with no order id older than this goes to `needs_review` (§9.4). */
export const REQUEST_ID_WINDOW_SECONDS = 2 * 60 * 60;
/** Automatic triggers pause this long after a decline. */
export const DECLINE_PAUSE_SECONDS = 900;

export type ClaimFailure = 'settlement_in_progress' | 'nothing_to_settle' | 'wallet_not_active' | 'not_due';

type Resolution =
  | { kind: 'completed'; orderId: string; captureId: string; captureStatus: string; fee?: number; net?: number }
  | { kind: 'declined'; reason: string; orderId?: string; captureId?: string; captureStatus?: string }
  | { kind: 'payer_stopped'; reason: string }
  | { kind: 'needs_review'; code: string; reason: string; orderId?: string; captureId?: string; captureStatus?: string };

type Gate = (wallet: WalletRow | undefined, operator: OperatorRow, now: number) => ClaimFailure | undefined;

const CLAIM_MESSAGES: Record<ClaimFailure, string> = {
  settlement_in_progress: 'A settlement is already in progress for this operator',
  nothing_to_settle: 'There are no unsettled paid calls to charge',
  wallet_not_active: 'The PayPal wallet is not active',
  not_due: 'No settlement is due',
};

export function claimMessage(failure: ClaimFailure): string {
  return CLAIM_MESSAGES[failure];
}

function readSettlement(ctx: ServiceContext, id: string): SettlementRow | undefined {
  return ctx.db.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
}

function retryAllowed(wallet: WalletRow | undefined, now: number): boolean {
  return wallet?.charge_retry_after === null || wallet?.charge_retry_after === undefined || wallet.charge_retry_after <= now;
}

/**
 * Redemption (design spec §9): triggers, the claim, the charge and its outcomes, retries and
 * recovery. Every outcome is a compare-and-set on `status = 'pending'`.
 */
export class SettlementService {
  readonly background = new BackgroundWork();
  private readonly ctx: ServiceContext;
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  get(id: string): SettlementRow | undefined {
    return readSettlement(this.ctx, id);
  }

  /**
   * The claim (design spec §9.2). Synchronous: call it inside an IMMEDIATE transaction. Selects
   * every `unsettled` commitment (plus `uncollectable` ones for `relink`), writes the settlement
   * and its items, and marks the commitments `settling`.
   */
  claimTx(operatorId: string, trigger: SettlementTrigger, now: number): SettlementRow | ClaimFailure {
    const { db } = this.ctx;
    if (db.prepare(`SELECT 1 FROM settlements WHERE operator_id = ? AND status = 'pending'`).get(operatorId)) {
      return 'settlement_in_progress';
    }
    const states = trigger === 'relink' ? `('unsettled', 'uncollectable')` : `('unsettled')`;
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM commitments
         WHERE operator_id = ? AND state IN ${states}`,
      )
      .get(operatorId) as { count: number; amount: number };
    if (totals.count === 0) return 'nothing_to_settle';
    const wallet = readWallet(db, operatorId);
    const id = randomId('stl');
    db.prepare(
      `INSERT INTO settlements
         (id, operator_id, trigger, status, amount, calls_count, paypal_request_id, vault_id_hash, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, operatorId, trigger, totals.amount, totals.count, id, wallet?.vault_id_hash ?? null, now, now);
    db.prepare(
      `INSERT INTO settlement_items (settlement_id, commitment_id, pay_to, amount)
       SELECT ?, id, pay_to, amount FROM commitments WHERE operator_id = ? AND state IN ${states}`,
    ).run(id, operatorId);
    db.prepare(
      `UPDATE commitments SET state = 'settling', settlement_id = ? WHERE operator_id = ? AND state IN ${states}`,
    ).run(id, operatorId);
    const row = readSettlement(this.ctx, id);
    if (!row) throw new Error('Claimed settlement disappeared');
    return row;
  }

  /** Emits `settlement.updated` for a new claim. Call after the claim's transaction commits. */
  afterClaim(row: SettlementRow): void {
    this.emitSettlement(row.id);
  }

  /** Threshold trigger (design spec §9.1). */
  async triggerThreshold(operatorId: string): Promise<SettlementRow | undefined> {
    return this.triggerGated(operatorId, 'threshold', (wallet, operator, now) => {
      if (wallet?.status !== 'active' || !retryAllowed(wallet, now)) return 'not_due';
      const { amount } = this.ctx.db
        .prepare(`SELECT COALESCE(SUM(amount), 0) AS amount FROM commitments WHERE operator_id = ? AND state = 'unsettled'`)
        .get(operator.id) as { amount: number };
      return amount >= Math.max(1, operator.cap_unsettled - operator.cap_per_call) ? undefined : 'not_due';
    });
  }

  /** Daily trigger (design spec §9.1). */
  async triggerDaily(operatorId: string): Promise<SettlementRow | undefined> {
    return this.triggerGated(operatorId, 'daily', (wallet, operator, now) => {
      if (wallet?.status !== 'active' || !retryAllowed(wallet, now)) return 'not_due';
      const old = this.ctx.db
        .prepare(`SELECT 1 FROM commitments WHERE operator_id = ? AND state = 'unsettled' AND recorded_at < ? LIMIT 1`)
        .get(operator.id, utcDayStart(now));
      return old ? undefined : 'not_due';
    });
  }

  /** Schedules a threshold check without awaiting it (used by the ledger's `onRecorded` hook). */
  scheduleThresholdCheck(operatorId: string): void {
    this.background.track(
      Promise.resolve()
        .then(() => this.triggerThreshold(operatorId))
        .catch((err: unknown) => {
          this.ctx.logger.error('Threshold check failed', { operatorId, error: errorMessage(err) });
        }),
    );
  }

  /** Manual trigger: 201 once the first attempt finishes, or a 409. */
  async settleManually(operatorId: string): Promise<SettlementRow> {
    const claimed = this.claimGated(operatorId, 'manual', (wallet) =>
      wallet?.status === 'active' ? undefined : 'wallet_not_active',
    );
    if (typeof claimed === 'string') throw conflict(claimed, claimMessage(claimed));
    this.afterClaim(claimed);
    await this.attempt(claimed.id);
    return readSettlement(this.ctx, claimed.id) ?? claimed;
  }

  /**
   * One charge attempt for a pending settlement without an order id. Concurrent calls for the
   * same settlement share one attempt. Uses the settlement id as the PayPal request id, so a
   * retry after a crash or a transient error repeats the same request.
   */
  attempt(settlementId: string): Promise<void> {
    const existing = this.inflight.get(settlementId);
    if (existing) return existing;
    const run = this.runAttempt(settlementId).finally(() => {
      this.inflight.delete(settlementId);
    });
    this.inflight.set(settlementId, run);
    return run;
  }

  /** Polls a pending settlement whose capture is `PENDING`. Errors wait for the next tick. */
  async poll(settlementId: string): Promise<void> {
    const s = readSettlement(this.ctx, settlementId);
    if (!s || s.status !== 'pending' || !s.paypal_order_id) return;
    let result: ChargeResult;
    try {
      result = await this.ctx.paypal.getOrder(s.paypal_order_id);
    } catch (err) {
      this.ctx.logger.warn('Capture poll failed', { settlementId, error: errorMessage(err) });
      return;
    }
    await this.applyChargeResult(s, result);
  }

  /** Recovery and retry work for one tick (design spec §9.4). */
  async runDue(now: number): Promise<void> {
    const due = this.ctx.db
      .prepare(
        `SELECT id FROM settlements WHERE status = 'pending' AND paypal_order_id IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at`,
      )
      .all(now) as { id: string }[];
    for (const { id } of due) {
      if (this.inflight.has(id)) continue;
      await this.attempt(id);
    }
    const polls = this.ctx.db
      .prepare(
        `SELECT id FROM settlements WHERE status = 'pending' AND paypal_order_id IS NOT NULL
         AND capture_status = 'PENDING' ORDER BY created_at`,
      )
      .all() as { id: string }[];
    for (const { id } of polls) await this.poll(id);
  }

  /** Threshold and daily triggers for every operator with an active wallet. */
  async runTriggers(): Promise<void> {
    const operators = this.ctx.db.prepare(`SELECT operator_id FROM wallets WHERE status = 'active'`).all() as {
      operator_id: string;
    }[];
    for (const { operator_id: operatorId } of operators) {
      await this.triggerThreshold(operatorId);
      await this.triggerDaily(operatorId);
    }
  }

  /**
   * Applies a `PAYMENT.CAPTURE.*` webhook (design spec §11). Returns a short outcome string for
   * `webhook_events.outcome`.
   */
  async applyCaptureWebhook(eventType: string, resource: Record<string, unknown>): Promise<string> {
    const captureId = typeof resource['id'] === 'string' ? resource['id'] : undefined;
    const related = resource['supplementary_data'] as { related_ids?: { order_id?: unknown } } | undefined;
    const orderId = typeof related?.related_ids?.order_id === 'string' ? related.related_ids.order_id : undefined;
    const s = this.findByPayPalIds(captureId, orderId);
    if (!s) return 'settlement_not_found';
    if (s.status !== 'pending') return 'already_resolved';
    if (eventType === 'PAYMENT.CAPTURE.PENDING') {
      this.pendingCaptureTx(s.id, s.paypal_order_id ?? orderId ?? null, captureId ?? null);
      return 'capture_pending';
    }
    if (eventType === 'PAYMENT.CAPTURE.DECLINED' || eventType === 'PAYMENT.CAPTURE.DENIED') {
      const applied = await this.resolve(s, {
        kind: 'declined',
        reason: eventType,
        ...(s.paypal_order_id ?? orderId ? { orderId: s.paypal_order_id ?? orderId ?? '' } : {}),
        ...(captureId === undefined ? {} : { captureId }),
        captureStatus: typeof resource['status'] === 'string' ? resource['status'] : 'DECLINED',
      });
      return applied ? 'declined' : 'already_resolved';
    }
    let capture;
    try {
      capture = mapCapture(resource);
    } catch (err) {
      return `invalid_capture: ${errorMessage(err)}`;
    }
    const before = s.status;
    await this.applyChargeResult(s, { orderId: s.paypal_order_id ?? orderId ?? '', orderStatus: 'COMPLETED', capture });
    const after = readSettlement(this.ctx, s.id)?.status;
    return before === after ? 'no_change' : `settlement_${after ?? 'missing'}`;
  }

  // --- internals -----------------------------------------------------------

  private findByPayPalIds(captureId: string | undefined, orderId: string | undefined): SettlementRow | undefined {
    const { db } = this.ctx;
    if (captureId) {
      const row = db.prepare('SELECT * FROM settlements WHERE paypal_capture_id = ?').get(captureId) as
        | SettlementRow
        | undefined;
      if (row) return row;
    }
    if (orderId) {
      return db.prepare('SELECT * FROM settlements WHERE paypal_order_id = ?').get(orderId) as SettlementRow | undefined;
    }
    return undefined;
  }

  private async triggerGated(operatorId: string, trigger: SettlementTrigger, gate: Gate): Promise<SettlementRow | undefined> {
    const claimed = this.claimGated(operatorId, trigger, gate);
    if (typeof claimed === 'string') return undefined;
    this.afterClaim(claimed);
    await this.attempt(claimed.id);
    return readSettlement(this.ctx, claimed.id);
  }

  /** Re-checks `gate` and claims in one IMMEDIATE transaction. */
  private claimGated(operatorId: string, trigger: SettlementTrigger, gate: Gate): SettlementRow | ClaimFailure {
    const { db } = this.ctx;
    const now = this.ctx.clock();
    return db
      .transaction((): SettlementRow | ClaimFailure => {
        const operator = db.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId) as OperatorRow | undefined;
        if (!operator) return 'not_due';
        const blocked = gate(readWallet(db, operatorId), operator, now);
        if (blocked) return blocked;
        return this.claimTx(operatorId, trigger, now);
      })
      .immediate();
  }

  private async runAttempt(settlementId: string): Promise<void> {
    const s = readSettlement(this.ctx, settlementId);
    if (!s || s.status !== 'pending' || s.paypal_order_id) return;
    const now = this.ctx.clock();
    if (now - s.created_at >= REQUEST_ID_WINDOW_SECONDS) {
      await this.resolve(s, {
        kind: 'needs_review',
        code: 'request_id_expired',
        reason: 'No PayPal order was recorded within the request id retention window',
      });
      return;
    }
    const wallet = readWallet(this.ctx.db, s.operator_id);
    if (!wallet?.vault_id_sealed || wallet.vault_id_hash !== s.vault_id_hash) {
      await this.resolve(s, {
        kind: 'needs_review',
        code: 'vault_unavailable',
        reason: 'The payment token this settlement was claimed against is no longer stored',
      });
      return;
    }
    let result: ChargeResult;
    try {
      result = await this.ctx.paypal.chargeVaultedWallet({
        vaultId: this.ctx.box.open(wallet.vault_id_sealed),
        amountCents: s.amount,
        requestId: s.paypal_request_id,
        invoiceId: s.id,
        description: `PayPer402 usage: ${s.calls_count} paid calls`,
      });
    } catch (err) {
      await this.applyError(s, err);
      return;
    }
    await this.applyChargeResult(s, result);
  }

  private async applyChargeResult(s: SettlementRow, result: ChargeResult): Promise<void> {
    const capture = result.capture;
    if (!capture) {
      await this.resolve(s, {
        kind: 'needs_review',
        code: 'no_capture',
        reason: `Order status ${result.orderStatus} without a capture`,
        ...(result.orderId ? { orderId: result.orderId } : {}),
      });
      return;
    }
    const ids = { orderId: result.orderId, captureId: capture.id, captureStatus: capture.status };
    switch (capture.status) {
      case 'COMPLETED':
        if (capture.amountCents !== s.amount) {
          await this.resolve(s, {
            kind: 'needs_review',
            code: 'amount_mismatch',
            reason: `Captured ${capture.amountCents} cents for a settlement of ${s.amount}`,
            ...ids,
          });
          return;
        }
        await this.resolve(s, {
          kind: 'completed',
          ...ids,
          ...(capture.feeCents === undefined ? {} : { fee: capture.feeCents }),
          ...(capture.netCents === undefined ? {} : { net: capture.netCents }),
        });
        return;
      case 'PENDING':
        this.pendingCaptureTx(s.id, result.orderId, capture.id);
        return;
      case 'DECLINED':
      case 'FAILED':
        await this.resolve(s, { kind: 'declined', reason: capture.statusReason ?? `Capture ${capture.status}`, ...ids });
        return;
      default:
        await this.resolve(s, {
          kind: 'needs_review',
          code: 'unexpected_capture_status',
          reason: `Capture status ${capture.status}`,
          ...ids,
        });
    }
  }

  private async applyError(s: SettlementRow, err: unknown): Promise<void> {
    const reason = err instanceof PayPalApiError && err.issues.length > 0 ? err.issues.join(',') : errorMessage(err);
    this.ctx.logger.warn('Settlement charge failed', { settlementId: s.id, class: classifyPayPalError(err), ...errorFields(err) });
    switch (classifyPayPalError(err)) {
      case 'revocation':
        await this.resolve(s, { kind: 'payer_stopped', reason });
        return;
      case 'decline':
        await this.resolve(s, {
          kind: 'declined',
          reason,
          ...(err instanceof PayPalApiError && err.orderId ? { orderId: err.orderId } : {}),
        });
        return;
      case 'transient':
        this.scheduleRetry(s);
        return;
      case 'duplicate': {
        const stored = readSettlement(this.ctx, s.id)?.paypal_order_id ?? null;
        const orderId = stored ?? (err instanceof PayPalApiError ? err.orderId : undefined);
        if (!orderId) {
          await this.resolve(s, { kind: 'needs_review', code: 'duplicate_without_order', reason });
          return;
        }
        let result: ChargeResult;
        try {
          result = await this.ctx.paypal.getOrder(orderId);
        } catch (lookupError) {
          if (classifyPayPalError(lookupError) === 'transient') {
            this.scheduleRetry(s);
            return;
          }
          await this.resolve(s, {
            kind: 'needs_review',
            code: 'duplicate_lookup_failed',
            reason: errorMessage(lookupError),
            orderId,
          });
          return;
        }
        await this.applyChargeResult(s, result);
        return;
      }
      default:
        await this.resolve(s, { kind: 'needs_review', code: 'paypal_error', reason });
    }
  }

  private scheduleRetry(s: SettlementRow): void {
    const now = this.ctx.clock();
    const attempts = s.attempts + 1;
    const delay = RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)] ?? 600;
    this.ctx.db
      .prepare(
        `UPDATE settlements SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now + delay, now, s.id);
  }

  /** Records a `PENDING` capture. Not a resolution: the settlement stays `pending`. */
  private pendingCaptureTx(id: string, orderId: string | null, captureId: string | null): boolean {
    const now = this.ctx.clock();
    return (
      this.ctx.db
        .prepare(
          `UPDATE settlements SET paypal_order_id = COALESCE(?, paypal_order_id),
             paypal_capture_id = COALESCE(?, paypal_capture_id), capture_status = 'PENDING',
             next_attempt_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(orderId, captureId, now, id).changes > 0
    );
  }

  /**
   * Writes an outcome (design spec §9.3) as one transaction that starts with the
   * compare-and-set on `status = 'pending'`. Returns false when another path already resolved
   * the settlement; then nothing else changes.
   */
  private async resolve(s: SettlementRow, r: Resolution): Promise<boolean> {
    const { db } = this.ctx;
    const now = this.ctx.clock();
    const outcome = db
      .transaction(() => {
        const params = {
          id: s.id,
          now,
          orderId: 'orderId' in r && r.orderId ? r.orderId : null,
          captureId: 'captureId' in r && r.captureId !== undefined ? r.captureId : null,
          captureStatus: 'captureStatus' in r && r.captureStatus !== undefined ? r.captureStatus : null,
        };
        let changed: number;
        switch (r.kind) {
          case 'completed':
            changed = db
              .prepare(
                `UPDATE settlements SET status = 'completed', paypal_order_id = COALESCE(@orderId, paypal_order_id),
                   paypal_capture_id = @captureId, capture_status = @captureStatus, fee = @fee, net = @net,
                   next_attempt_at = NULL, completed_at = @now, updated_at = @now
                 WHERE id = @id AND status = 'pending'`,
              )
              .run({ ...params, fee: r.fee ?? null, net: r.net ?? null }).changes;
            break;
          case 'declined':
          case 'payer_stopped':
          case 'needs_review':
            changed = db
              .prepare(
                `UPDATE settlements SET status = @status, failure_code = @code, failure_reason = @reason,
                   paypal_order_id = COALESCE(@orderId, paypal_order_id),
                   paypal_capture_id = COALESCE(@captureId, paypal_capture_id),
                   capture_status = COALESCE(@captureStatus, capture_status),
                   next_attempt_at = NULL, updated_at = @now
                 WHERE id = @id AND status = 'pending'`,
              )
              .run({
                ...params,
                status: r.kind === 'needs_review' ? 'needs_review' : 'failed',
                code: r.kind === 'needs_review' ? r.code : r.kind === 'declined' ? 'declined' : 'payer_stopped',
                reason: r.reason.slice(0, 1000),
              }).changes;
            break;
        }
        if (changed === 0) return undefined;

        let walletChanged = false;
        let sealedToDelete: string | undefined;
        const relink = s.trigger === 'relink';
        // For relink, the wallet is touched only when rule (b) matches (design spec §5).
        const clearRetry = () =>
          db.prepare('UPDATE wallets SET charge_retry_after = NULL WHERE operator_id = ?').run(s.operator_id);
        if (r.kind === 'completed') {
          db.prepare(`UPDATE commitments SET state = 'settled' WHERE settlement_id = ? AND state = 'settling'`).run(s.id);
          if (relink) {
            walletChanged = relinkOutcomeTx(db, s.operator_id, s.vault_id_hash, 'completed', now).changed;
            if (walletChanged) clearRetry();
          } else {
            clearRetry();
          }
        } else if (r.kind === 'declined') {
          const walletStatus = readWallet(db, s.operator_id)?.status;
          const stillUsable = walletStatus === 'active' || walletStatus === 'unlinking';
          if (relink || !stillUsable) {
            // Relink, or the wallet was revoked (or otherwise left) meanwhile: the batch cannot be
            // charged again on this wallet, so it stays with this settlement as uncollectable.
            db.prepare(`UPDATE commitments SET state = 'uncollectable' WHERE settlement_id = ? AND state = 'settling'`).run(s.id);
          } else {
            db.prepare(
              `UPDATE commitments SET state = 'unsettled', settlement_id = NULL WHERE settlement_id = ? AND state = 'settling'`,
            ).run(s.id);
          }
          if (!relink) {
            db.prepare('UPDATE wallets SET charge_retry_after = ? WHERE operator_id = ?').run(
              now + DECLINE_PAUSE_SECONDS,
              s.operator_id,
            );
          }
          if (s.trigger === 'unlink') walletChanged = unlinkDeclinedTx(db, s.operator_id, now);
          if (relink) {
            const result = relinkOutcomeTx(db, s.operator_id, s.vault_id_hash, 'failed', now);
            walletChanged = result.changed;
            sealedToDelete = result.sealedToDelete;
          }
        } else if (r.kind === 'payer_stopped') {
          db.prepare(`UPDATE commitments SET state = 'uncollectable' WHERE settlement_id = ? AND state = 'settling'`).run(s.id);
          if (relink) {
            const result = relinkOutcomeTx(db, s.operator_id, s.vault_id_hash, 'failed', now);
            walletChanged = result.changed;
            sealedToDelete = result.sealedToDelete;
          } else {
            db.prepare(`UPDATE commitments SET state = 'uncollectable' WHERE operator_id = ? AND state = 'unsettled'`).run(
              s.operator_id,
            );
            walletChanged = revokeWalletTx(db, s.operator_id, now, s.vault_id_hash);
          }
        }
        return { walletChanged, sealedToDelete };
      })
      .immediate();
    if (!outcome) return false;

    this.emitSettlement(s.id);
    if (r.kind === 'needs_review' || r.kind === 'payer_stopped') {
      recordAudit(db, this.ctx.logger, now, {
        actorType: 'system',
        action: r.kind === 'needs_review' ? 'settlement.needs_review' : 'settlement.payer_stopped',
        resourceType: 'settlement',
        resourceId: s.id,
        details: { operatorId: s.operator_id, trigger: s.trigger, reason: r.reason, ...(r.kind === 'needs_review' ? { code: r.code } : {}) },
      });
    }
    if (outcome.walletChanged) {
      if (r.kind === 'payer_stopped' && s.trigger !== 'relink') {
        recordAudit(db, this.ctx.logger, now, {
          actorType: 'paypal',
          action: 'wallet.revoked',
          resourceType: 'wallet',
          resourceId: s.operator_id,
          details: { via: 'charge_error', settlementId: s.id },
        });
      }
      emitWallet(this.ctx, s.operator_id);
    }
    if (outcome.sealedToDelete) await deleteVaultToken(this.ctx, outcome.sealedToDelete, s.operator_id);
    if (r.kind === 'completed' && s.trigger === 'unlink') await finishUnlink(this.ctx, s.operator_id, s.vault_id_hash);
    return true;
  }

  private emitSettlement(id: string): void {
    const row = readSettlement(this.ctx, id);
    if (!row) return;
    this.ctx.events.emit({
      type: 'settlement.updated',
      operatorId: row.operator_id,
      data: { id: row.id, status: row.status, trigger: row.trigger, amount: row.amount, callsCount: row.calls_count },
    });
  }
}
