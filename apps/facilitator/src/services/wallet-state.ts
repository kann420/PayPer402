/**
 * Wallet writes shared by the wallet and settlement services. The `...Tx` functions are
 * synchronous and meant to run inside a caller's transaction; each is a compare-and-set
 * (design spec §5) and reports whether it changed the row.
 */
import { PayPalApiError } from '@payper402/paypal-client';
import { recordAudit } from '../audit';
import type { Db } from '../db/connection';
import { errorFields } from '../logger';
import { readWallet, type ServiceContext } from './context';

/** The columns that describe a linked payment token. */
export const CLEAR_VAULT_COLUMNS =
  'vault_id_sealed = NULL, vault_id_hash = NULL, paypal_customer_id = NULL, payer_email_masked = NULL';

/**
 * Revokes a wallet (design spec §12), rule (d): only from `active` or `unlinking`. When
 * `vaultIdHash` is given, the wallet must still hold that payment token, so a check or charge
 * against an old token never revokes a newer link. Every `unsettled` commitment of the operator
 * becomes `uncollectable`.
 */
export function revokeWalletTx(db: Db, operatorId: string, now: number, vaultIdHash?: string | null): boolean {
  const guard = vaultIdHash === undefined ? '' : ' AND vault_id_hash IS @vaultIdHash';
  const result = db
    .prepare(
      `UPDATE wallets SET status = 'stopped_by_payer', stopped_at = @now, updated_at = @now
       WHERE operator_id = @operatorId AND status IN ('active', 'unlinking')${guard}`,
    )
    .run({ now, operatorId, ...(vaultIdHash === undefined ? {} : { vaultIdHash }) });
  if (result.changes === 0) return false;
  db.prepare(`UPDATE commitments SET state = 'uncollectable' WHERE operator_id = ? AND state = 'unsettled'`).run(
    operatorId,
  );
  return true;
}

/**
 * Revokes every holder of a payment token (design spec §5.1, §12): each wallet with that hash in
 * `active` or `unlinking`, through rule (d). A holder in `waiting_for_approval` is left to its
 * relink settlement. Returns the revoked operator ids; call `afterRevoke` for each once the
 * transaction has committed. A null hash revokes nothing.
 */
export function revokeTokenHoldersTx(db: Db, vaultIdHash: string | null, now: number): string[] {
  if (vaultIdHash === null) return [];
  const holders = db
    .prepare(`SELECT operator_id FROM wallets WHERE vault_id_hash = ? AND status IN ('active', 'unlinking') ORDER BY operator_id`)
    .all(vaultIdHash) as { operator_id: string }[];
  return holders
    .map((row) => row.operator_id)
    .filter((operatorId) => revokeWalletTx(db, operatorId, now, vaultIdHash));
}

/** Audit and `wallet.updated` for one revoked wallet, after the revoking transaction commits. */
export function afterRevoke(ctx: ServiceContext, operatorId: string, now: number, details: Record<string, unknown>): void {
  recordAudit(ctx.db, ctx.logger, now, {
    actorType: 'paypal',
    action: 'wallet.revoked',
    resourceType: 'wallet',
    resourceId: operatorId,
    details,
  });
  emitWallet(ctx, operatorId);
}

export interface RelinkOutcomeResult {
  changed: boolean;
  /** Sealed payment token to release (rule (e)) after the commit (failed outcome only). */
  sealedToDelete?: string;
}

/**
 * Applies the wallet part of a relink outcome (design spec §8 step 3), rule (b): only while the
 * wallet is still `waiting_for_approval` with the vault id the relink settlement charged. If it
 * no longer matches, nothing changes and nothing is deleted.
 */
export function relinkOutcomeTx(
  db: Db,
  operatorId: string,
  vaultIdHash: string | null,
  outcome: 'completed' | 'failed',
  now: number,
): RelinkOutcomeResult {
  if (vaultIdHash === null) return { changed: false };
  const where = `operator_id = @operatorId AND status = 'waiting_for_approval' AND vault_id_hash = @vaultIdHash`;
  const params = { operatorId, vaultIdHash, now };
  if (outcome === 'completed') {
    const result = db
      .prepare(
        `UPDATE wallets SET status = 'active', linked_at = @now, link_error = NULL, stopped_at = NULL,
           last_checked_at = NULL, updated_at = @now WHERE ${where}`,
      )
      .run(params);
    return { changed: result.changes > 0 };
  }
  const row = db.prepare(`SELECT vault_id_sealed FROM wallets WHERE ${where}`).get(params) as
    | { vault_id_sealed: string | null }
    | undefined;
  if (!row) return { changed: false };
  db.prepare(
    `UPDATE wallets SET status = 'link_failed', link_error = 'relink_settlement_failed', ${CLEAR_VAULT_COLUMNS},
       updated_at = @now WHERE ${where}`,
  ).run(params);
  return row.vault_id_sealed === null ? { changed: true } : { changed: true, sealedToDelete: row.vault_id_sealed };
}

/** Unlink follow-up after a declined unlink settlement, rule (c): back to `active`. */
export function unlinkDeclinedTx(db: Db, operatorId: string, now: number): boolean {
  return (
    db
      .prepare(`UPDATE wallets SET status = 'active', updated_at = ? WHERE operator_id = ? AND status = 'unlinking'`)
      .run(now, operatorId).changes > 0
  );
}

function auditDeleteFailed(ctx: ServiceContext, operatorId: string, err: unknown): void {
  ctx.logger.warn('Could not delete a payment token at PayPal', { operatorId, ...errorFields(err) });
  recordAudit(ctx.db, ctx.logger, ctx.clock(), {
    actorType: 'system',
    action: 'wallet.token_delete_failed',
    resourceType: 'wallet',
    resourceId: operatorId,
    details: { ...errorFields(err) },
  });
}

/**
 * Deletes a payment token at PayPal, best effort. "Not found" counts as deleted. The only code
 * that calls PayPal's DELETE; reach it through `releaseVaultId` / `releaseVaultToken`.
 */
async function deleteVaultToken(ctx: ServiceContext, vaultId: string, operatorId: string): Promise<boolean> {
  try {
    await ctx.paypal.deletePaymentToken(vaultId);
    return true;
  } catch (err) {
    if (err instanceof PayPalApiError && err.httpStatus === 404) return true;
    auditDeleteFailed(ctx, operatorId, err);
    return false;
  }
}

/**
 * Releases a payment token for `operatorId`, rule (e) (design spec §5.1). Another live holder
 * (a different wallet with the same hash in `active`, `unlinking` or `waiting_for_approval`)
 * keeps the token at PayPal: the DELETE is skipped and `wallet.token_kept_shared` is audited.
 * Otherwise the token is deleted. The caller clears its own vault columns.
 */
export async function releaseVaultId(ctx: ServiceContext, vaultId: string, operatorId: string): Promise<void> {
  const shared = ctx.db
    .prepare(
      `SELECT 1 FROM wallets WHERE operator_id <> ? AND vault_id_hash = ?
         AND status IN ('active', 'unlinking', 'waiting_for_approval') LIMIT 1`,
    )
    .get(operatorId, ctx.box.lookupHash(vaultId));
  if (shared === undefined) {
    await deleteVaultToken(ctx, vaultId, operatorId);
    return;
  }
  // No token id and no hash in the details.
  recordAudit(ctx.db, ctx.logger, ctx.clock(), {
    actorType: 'system',
    action: 'wallet.token_kept_shared',
    resourceType: 'wallet',
    resourceId: operatorId,
  });
}

/** `releaseVaultId` for a sealed column value. A value that cannot be opened is audited like a failed delete. */
export async function releaseVaultToken(ctx: ServiceContext, sealed: string, operatorId: string): Promise<void> {
  let vaultId: string;
  try {
    vaultId = ctx.box.open(sealed);
  } catch (err) {
    auditDeleteFailed(ctx, operatorId, err);
    return;
  }
  await releaseVaultId(ctx, vaultId, operatorId);
}

/**
 * Unlink step 4 (design spec §10): release the payment token (rule (e)), clear the vault
 * columns, then with rule (c) set `not_linked`. A wallet revoked meanwhile keeps
 * `stopped_by_payer`, but its vault columns are still cleared. Only the token `vaultIdHash` is
 * touched, so a newer link is never affected.
 */
export async function finishUnlink(ctx: ServiceContext, operatorId: string, vaultIdHash: string | null): Promise<void> {
  const wallet = readWallet(ctx.db, operatorId);
  if (!wallet || (wallet.status !== 'unlinking' && wallet.status !== 'stopped_by_payer')) return;
  if (wallet.vault_id_hash !== vaultIdHash) return;
  if (wallet.vault_id_sealed) await releaseVaultToken(ctx, wallet.vault_id_sealed, operatorId);
  const now = ctx.clock();
  const statusChanged = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE wallets SET ${CLEAR_VAULT_COLUMNS}, updated_at = @now
         WHERE operator_id = @operatorId AND status IN ('unlinking', 'stopped_by_payer') AND vault_id_hash IS @vaultIdHash`,
      )
      .run({ now, operatorId, vaultIdHash });
    return (
      ctx.db
        .prepare(
          `UPDATE wallets SET status = 'not_linked', linked_at = NULL, updated_at = ?
           WHERE operator_id = ? AND status = 'unlinking'`,
        )
        .run(now, operatorId).changes > 0
    );
  }).immediate();
  if (statusChanged) {
    recordAudit(ctx.db, ctx.logger, now, {
      actorType: 'operator',
      actorId: operatorId,
      action: 'wallet.unlinked',
      resourceType: 'wallet',
      resourceId: operatorId,
    });
    emitWallet(ctx, operatorId);
  }
}

/** Emits `wallet.updated` with the wallet's current status. */
export function emitWallet(ctx: ServiceContext, operatorId: string): void {
  const wallet = readWallet(ctx.db, operatorId);
  if (wallet) ctx.events.emit({ type: 'wallet.updated', operatorId, data: { status: wallet.status } });
}
