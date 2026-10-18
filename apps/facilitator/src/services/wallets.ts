import { PayPalApiError, classifyPayPalError, type PaymentTokenResult } from '@payper402/paypal-client';
import { recordAudit } from '../audit';
import { randomToken } from '../crypto';
import type { SettlementRow, WalletRow } from '../db/rows';
import { conflict } from '../http';
import { errorFields } from '../logger';
import { ensureWallet, maskEmail, readWallet, type ServiceContext } from './context';
import type { SettlementService } from './settlements';
import {
  CLEAR_VAULT_COLUMNS,
  afterRevoke,
  emitWallet,
  finishUnlink,
  releaseVaultId,
  releaseVaultToken,
  revokeTokenHoldersTx,
} from './wallet-state';

export const LINK_DESCRIPTION =
  'PayPer402: your AI agents pay per API call; charges are batched to this PayPal account.';
export const BRAND_NAME = 'PayPer402';
/** PayPal's setup-token expiry. */
export const SETUP_TOKEN_TTL_SECONDS = 3 * 86_400;
export const HEALTH_CHECKS_PER_TICK = 10;

export interface UnlinkResult {
  wallet: WalletRow;
  /** Set when the endpoint answers 409. */
  error?: 'settlement_failed' | 'settlement_in_progress';
}

/** Wallet linking, unlinking, expiry and revocation (design spec §8, §10, §12). */
export class WalletService {
  private readonly ctx: ServiceContext;
  private readonly settlements: SettlementService;

  constructor(ctx: ServiceContext, settlements: SettlementService) {
    this.ctx = ctx;
    this.settlements = settlements;
  }

  get(operatorId: string): WalletRow {
    ensureWallet(this.ctx.db, operatorId, this.ctx.clock());
    const wallet = readWallet(this.ctx.db, operatorId);
    if (!wallet) throw new Error('Wallet row missing');
    return wallet;
  }

  relinkPending(operatorId: string): boolean {
    return (
      this.ctx.db
        .prepare(`SELECT 1 FROM settlements WHERE operator_id = ? AND status = 'pending' AND trigger = 'relink'`)
        .get(operatorId) !== undefined
    );
  }

  /** `POST /v1/operator/wallet/link` (design spec §8 step 1). */
  async startLink(operatorId: string): Promise<{ approveUrl: string; expiresAt: number }> {
    const { ctx } = this;
    const wallet = this.get(operatorId);
    this.assertCanLink(wallet);
    if (wallet.vault_id_sealed) await releaseVaultToken(ctx, wallet.vault_id_sealed, operatorId);

    const state = randomToken(16);
    const query = `state=${encodeURIComponent(state)}`;
    const setupToken = await ctx.paypal.createSetupToken({
      returnUrl: `${ctx.config.publicBaseUrl}/paypal/return?${query}`,
      cancelUrl: `${ctx.config.publicBaseUrl}/paypal/cancel?${query}`,
      description: LINK_DESCRIPTION,
      brandName: BRAND_NAME,
      requestId: `link_${state}`,
    });

    const now = ctx.clock();
    ctx.db
      .transaction(() => {
        this.assertCanLink(this.get(operatorId));
        ctx.db
          .prepare(
            `UPDATE wallets SET status = 'waiting_for_approval', link_state = ?, setup_token_id = ?, link_started_at = ?,
               link_error = NULL, linked_at = NULL, ${CLEAR_VAULT_COLUMNS}, updated_at = ?
             WHERE operator_id = ?`,
          )
          .run(state, setupToken.id, now, now, operatorId);
      })
      .immediate();
    recordAudit(ctx.db, ctx.logger, now, {
      actorType: 'operator',
      actorId: operatorId,
      action: 'wallet.link_started',
      resourceType: 'wallet',
      resourceId: operatorId,
    });
    emitWallet(ctx, operatorId);
    return { approveUrl: setupToken.approveUrl, expiresAt: now + SETUP_TOKEN_TTL_SECONDS };
  }

  /** Operator id of the wallet holding this link `state`, if any. */
  findByState(state: string): string | undefined {
    const row = this.ctx.db.prepare('SELECT operator_id FROM wallets WHERE link_state = ?').get(state) as
      | { operator_id: string }
      | undefined;
    return row?.operator_id;
  }

  /**
   * Finishes a link (design spec §8 step 2), for `/paypal/return` and `/refresh`. Returns the
   * wallet as it now is. The write uses compare-and-set rule (a).
   */
  async finish(operatorId: string, expectedState?: string): Promise<WalletRow> {
    const { ctx } = this;
    const wallet = this.get(operatorId);
    const state = wallet.link_state;
    const setupTokenId = wallet.setup_token_id;
    if (wallet.status !== 'waiting_for_approval' || !state || !setupTokenId) return wallet;
    if (expectedState !== undefined && expectedState !== state) return wallet;

    const setupToken = await ctx.paypal.getSetupToken(setupTokenId);
    // `VAULTED`: an earlier attempt created the payment token but its result was never stored.
    // The same request id returns that token (design spec §8 step 2).
    if (setupToken.status !== 'APPROVED' && setupToken.status !== 'VAULTED') return this.get(operatorId);
    let paymentToken: PaymentTokenResult;
    try {
      paymentToken = await ctx.paypal.createPaymentToken(setupTokenId, state);
    } catch (err) {
      // Transient: the wallet stays as it is and a later refresh repeats the request (through
      // `VAULTED` if PayPal did process it). Any other failure ends the link.
      if (classifyPayPalError(err) === 'transient') throw err;
      return this.failLink(operatorId, state, setupTokenId, err);
    }

    const now = ctx.clock();
    let vaultIdHash: string;
    let result: { won: false } | { won: true; settlement?: SettlementRow };
    try {
      vaultIdHash = ctx.box.lookupHash(paymentToken.id);
      const sealed = ctx.box.seal(paymentToken.id);
      result = this.storeTx(operatorId, state, setupTokenId, paymentToken, vaultIdHash, sealed, now);
    } catch (err) {
      return this.failLink(operatorId, state, setupTokenId, err, paymentToken.id);
    }

    if (!result.won) {
      const current = this.get(operatorId);
      if (current.vault_id_hash !== vaultIdHash) await releaseVaultId(ctx, paymentToken.id, operatorId);
      return current;
    }
    recordAudit(ctx.db, ctx.logger, now, {
      actorType: 'operator',
      actorId: operatorId,
      action: 'wallet.payment_token_saved',
      resourceType: 'wallet',
      resourceId: operatorId,
      details: { relink: result.settlement !== undefined },
    });
    if (result.settlement) {
      this.settlements.afterClaim(result.settlement);
      await this.settlements.attempt(result.settlement.id);
    }
    emitWallet(ctx, operatorId);
    return this.get(operatorId);
  }

  /**
   * Stores a created payment token with compare-and-set rule (a), then activates the wallet or
   * claims its relink settlement, in one IMMEDIATE transaction. The token may already be held by
   * other wallets (design spec §5.1).
   */
  private storeTx(
    operatorId: string,
    state: string,
    setupTokenId: string,
    paymentToken: PaymentTokenResult,
    vaultIdHash: string,
    sealed: string,
    now: number,
  ): { won: false } | { won: true; settlement?: SettlementRow } {
    const { ctx } = this;
    return ctx.db
      .transaction((): { won: false } | { won: true; settlement?: SettlementRow } => {
        const written = ctx.db
          .prepare(
            `UPDATE wallets SET vault_id_sealed = @sealed, vault_id_hash = @vaultIdHash, paypal_customer_id = @customerId,
               payer_email_masked = @email, link_state = NULL, setup_token_id = NULL, updated_at = @now
             WHERE operator_id = @operatorId AND status = 'waiting_for_approval'
               AND link_state = @state AND setup_token_id = @setupTokenId`,
          )
          .run({
            sealed,
            vaultIdHash,
            customerId: paymentToken.customerId ?? null,
            email: maskEmail(paymentToken.payerEmail),
            now,
            operatorId,
            state,
            setupTokenId,
          });
        if (written.changes === 0) return { won: false };
        if (this.uncollectableCount(operatorId) === 0) {
          this.activateTx(operatorId, now);
          return { won: true };
        }
        const claimed = this.settlements.claimTx(operatorId, 'relink', now);
        return typeof claimed === 'string' ? { won: true } : { won: true, settlement: claimed };
      })
      .immediate();
  }

  /**
   * The payment-token step failed (design spec §8 step 2): `link_failed` with
   * `payment_token_failed`, under rule (a). A token this attempt created is released once the
   * write has committed. If another path won, it is released only when the wallet now holds a
   * different token; a twin that stored the same token keeps it.
   */
  private async failLink(
    operatorId: string,
    state: string,
    setupTokenId: string,
    err: unknown,
    createdVaultId?: string,
  ): Promise<WalletRow> {
    const { ctx } = this;
    const now = ctx.clock();
    const changed = ctx.db
      .transaction(
        () =>
          ctx.db
            .prepare(
              `UPDATE wallets SET status = 'link_failed', link_error = 'payment_token_failed', link_state = NULL,
                 setup_token_id = NULL, updated_at = ?
               WHERE operator_id = ? AND status = 'waiting_for_approval' AND link_state = ? AND setup_token_id = ?`,
            )
            .run(now, operatorId, state, setupTokenId).changes,
      )
      .immediate();
    if (changed === 0) {
      const current = this.get(operatorId);
      if (createdVaultId !== undefined && current.vault_id_hash !== ctx.box.lookupHash(createdVaultId)) {
        await releaseVaultId(ctx, createdVaultId, operatorId);
      }
      return current;
    }
    emitWallet(ctx, operatorId);
    if (createdVaultId !== undefined) await releaseVaultId(ctx, createdVaultId, operatorId);
    // Error fields only: never a token id.
    ctx.logger.warn('Finishing a link failed at the payment-token step', { operatorId, ...errorFields(err) });
    recordAudit(ctx.db, ctx.logger, now, {
      actorType: 'system',
      action: 'wallet.link_failed',
      resourceType: 'wallet',
      resourceId: operatorId,
      details: { ...errorFields(err) },
    });
    return this.get(operatorId);
  }

  /** `/paypal/cancel`: marks a pending link `link_failed` with `link_error: 'cancelled'`. */
  cancel(state: string): string | undefined {
    const { ctx } = this;
    const operatorId = this.findByState(state);
    if (!operatorId) return undefined;
    const changed = ctx.db
      .prepare(
        `UPDATE wallets SET status = 'link_failed', link_error = 'cancelled', link_state = NULL, setup_token_id = NULL,
           updated_at = ?
         WHERE operator_id = ? AND link_state = ? AND status = 'waiting_for_approval' AND vault_id_sealed IS NULL`,
      )
      .run(ctx.clock(), operatorId, state).changes;
    if (changed > 0) emitWallet(ctx, operatorId);
    return operatorId;
  }

  /** Expiry (design spec §8 step 4): only before a payment token exists. */
  expireLinks(now: number): number {
    const { db } = this.ctx;
    const where = `status = 'waiting_for_approval' AND setup_token_id IS NOT NULL AND vault_id_sealed IS NULL
      AND link_started_at < ?`;
    const cutoff = now - SETUP_TOKEN_TTL_SECONDS;
    const expired = db.transaction(() => {
      const rows = db.prepare(`SELECT operator_id FROM wallets WHERE ${where}`).all(cutoff) as { operator_id: string }[];
      db.prepare(
        `UPDATE wallets SET status = 'link_failed', link_error = 'expired', link_state = NULL, setup_token_id = NULL,
           updated_at = ? WHERE ${where}`,
      ).run(now, cutoff);
      return rows.map((row) => row.operator_id);
    })();
    for (const operatorId of expired) emitWallet(this.ctx, operatorId);
    return expired.length;
  }

  /** `POST /v1/operator/wallet/unlink` (design spec §10). */
  async unlink(operatorId: string): Promise<UnlinkResult> {
    const { ctx } = this;
    this.get(operatorId);
    const now = ctx.clock();
    const claimed = ctx.db
      .transaction((): { vaultIdHash: string | null; settlement?: SettlementRow } => {
        const wallet = this.get(operatorId);
        if (wallet.status !== 'active') throw conflict('wallet_not_active', 'Only an active wallet can be unlinked');
        if (ctx.db.prepare(`SELECT 1 FROM settlements WHERE operator_id = ? AND status = 'pending'`).get(operatorId)) {
          throw conflict('settlement_in_progress', 'A settlement is in progress; try again when it finishes');
        }
        ctx.db
          .prepare(`UPDATE wallets SET status = 'unlinking', updated_at = ? WHERE operator_id = ? AND status = 'active'`)
          .run(now, operatorId);
        const settlement = this.settlements.claimTx(operatorId, 'unlink', now);
        return typeof settlement === 'string'
          ? { vaultIdHash: wallet.vault_id_hash }
          : { vaultIdHash: wallet.vault_id_hash, settlement };
      })
      .immediate();
    recordAudit(ctx.db, ctx.logger, now, {
      actorType: 'operator',
      actorId: operatorId,
      action: 'wallet.unlink_requested',
      resourceType: 'wallet',
      resourceId: operatorId,
    });
    emitWallet(ctx, operatorId);

    if (!claimed.settlement) {
      await finishUnlink(ctx, operatorId, claimed.vaultIdHash);
      return { wallet: this.get(operatorId) };
    }
    this.settlements.afterClaim(claimed.settlement);
    await this.settlements.attempt(claimed.settlement.id);
    const settlement = this.settlements.get(claimed.settlement.id);
    const wallet = this.get(operatorId);
    if (settlement?.status === 'completed') return { wallet };
    if (settlement?.status === 'failed') {
      return settlement.failure_code === 'declined' ? { wallet, error: 'settlement_failed' } : { wallet };
    }
    return { wallet, error: 'settlement_in_progress' };
  }

  /**
   * Webhook revocation (`VAULT.PAYMENT-TOKEN.DELETED`, design spec §11): revokes every holder of
   * the token in `active` or `unlinking`. Returns the webhook outcome.
   */
  revokeByVaultId(vaultId: string): string {
    const { ctx } = this;
    const vaultIdHash = ctx.box.lookupHash(vaultId);
    const now = ctx.clock();
    const result = ctx.db
      .transaction((): { held: boolean; revoked: string[] } => {
        const held = ctx.db.prepare('SELECT 1 FROM wallets WHERE vault_id_hash = ? LIMIT 1').get(vaultIdHash) !== undefined;
        return { held, revoked: held ? revokeTokenHoldersTx(ctx.db, vaultIdHash, now) : [] };
      })
      .immediate();
    if (!result.held) return 'wallet_not_found';
    if (result.revoked.length === 0) return 'wallet_not_revocable';
    for (const operatorId of result.revoked) afterRevoke(ctx, operatorId, now, { via: 'webhook' });
    return 'wallet_revoked';
  }

  /**
   * Health check (design spec §12): at most 10 wallets per tick, oldest check first. A 404 or a
   * revocation-class issue revokes every holder of the checked token (§5.1); only the checked
   * wallet's `last_checked_at` is written. Any other error waits for the next check. A selected
   * wallet that was revoked earlier in the same tick (it shared a token) is not checked again.
   */
  async healthCheck(now: number): Promise<number> {
    const { ctx } = this;
    const rows = ctx.db
      .prepare(
        `SELECT operator_id, vault_id_sealed, vault_id_hash FROM wallets
         WHERE status IN ('active', 'unlinking') AND vault_id_sealed IS NOT NULL
           AND (last_checked_at IS NULL OR last_checked_at <= ?)
         ORDER BY COALESCE(last_checked_at, 0) ASC, operator_id ASC LIMIT ?`,
      )
      .all(now - ctx.config.walletCheckIntervalSeconds, HEALTH_CHECKS_PER_TICK) as {
      operator_id: string;
      vault_id_sealed: string;
      vault_id_hash: string;
    }[];
    let revokedCount = 0;
    for (const row of rows) {
      const current = readWallet(ctx.db, row.operator_id);
      if ((current?.status !== 'active' && current?.status !== 'unlinking') || current.vault_id_hash !== row.vault_id_hash) {
        continue;
      }
      let revoke = false;
      try {
        await ctx.paypal.getPaymentToken(ctx.box.open(row.vault_id_sealed));
      } catch (err) {
        revoke = (err instanceof PayPalApiError && err.httpStatus === 404) || classifyPayPalError(err) === 'revocation';
        if (!revoke) {
          ctx.logger.warn('Wallet health check failed; will retry', { operatorId: row.operator_id, ...errorFields(err) });
        }
      }
      const checkedAt = ctx.clock();
      const revoked = ctx.db
        .transaction(() => {
          ctx.db.prepare('UPDATE wallets SET last_checked_at = ? WHERE operator_id = ?').run(checkedAt, row.operator_id);
          return revoke ? revokeTokenHoldersTx(ctx.db, row.vault_id_hash, checkedAt) : [];
        })
        .immediate();
      for (const operatorId of revoked) {
        revokedCount += 1;
        afterRevoke(ctx, operatorId, checkedAt, { via: 'health_check' });
      }
    }
    return revokedCount;
  }

  /**
   * Claims a relink settlement for a wallet that holds a new payment token but could not claim
   * one at link time because another settlement was pending.
   */
  async resumeRelinks(): Promise<void> {
    const rows = this.ctx.db
      .prepare(
        `SELECT w.operator_id FROM wallets w
         WHERE w.status = 'waiting_for_approval' AND w.vault_id_sealed IS NOT NULL AND w.setup_token_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.operator_id = w.operator_id AND s.status = 'pending')
           AND EXISTS (SELECT 1 FROM commitments c WHERE c.operator_id = w.operator_id AND c.state = 'uncollectable')`,
      )
      .all() as { operator_id: string }[];
    for (const { operator_id: operatorId } of rows) {
      const now = this.ctx.clock();
      const claimed = this.ctx.db.transaction(() => this.settlements.claimTx(operatorId, 'relink', now)).immediate();
      if (typeof claimed === 'string') continue;
      this.settlements.afterClaim(claimed);
      await this.settlements.attempt(claimed.id);
    }
  }

  // --- internals -----------------------------------------------------------

  private assertCanLink(wallet: WalletRow): void {
    if (wallet.status === 'active' || wallet.status === 'unlinking') {
      throw conflict('wallet_already_active', 'The wallet is already linked');
    }
    if (this.relinkPending(wallet.operator_id)) {
      throw conflict('settlement_in_progress', 'A settlement for the new wallet is in progress');
    }
    // A finished link waiting to claim its relink (design spec §8 step 1): restarting now would
    // delete the new payment token while another settlement is still being charged.
    if (
      wallet.status === 'waiting_for_approval' &&
      wallet.vault_id_sealed !== null &&
      this.ctx.db.prepare(`SELECT 1 FROM settlements WHERE operator_id = ? AND status = 'pending'`).get(wallet.operator_id)
    ) {
      throw conflict('settlement_in_progress', 'A settlement is in progress; try again when it finishes');
    }
  }

  private uncollectableCount(operatorId: string): number {
    const row = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM commitments WHERE operator_id = ? AND state = 'uncollectable'`)
      .get(operatorId) as { n: number };
    return row.n;
  }

  private activateTx(operatorId: string, now: number): void {
    this.ctx.db
      .prepare(
        `UPDATE wallets SET status = 'active', linked_at = ?, link_error = NULL, stopped_at = NULL,
           last_checked_at = NULL, charge_retry_after = NULL, updated_at = ? WHERE operator_id = ?`,
      )
      .run(now, now, operatorId);
  }
}

