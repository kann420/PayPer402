import { Router } from 'express';
import { assertValidCaps, type Caps } from '@payper402/scheme-paypal';
import { PayPalApiError, PayPalNetworkError } from '@payper402/paypal-client';
import { z } from 'zod';
import { recordAudit } from '../audit';
import { authOf } from '../auth';
import type { OperatorRow, SettlementRow } from '../db/rows';
import { conflict, handler, HttpError, notFound, parse } from '../http';
import type { ServiceContext } from '../services/context';
import type { WalletService } from '../services/wallets';
import { snapshotSync } from '../stores';
import { capsView, operatorBlockReason, settlementView, walletView } from '../views';

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const capsSchema = z
  .strictObject({ perCall: cents, daily: cents, unsettled: cents, total: cents.nullable().optional() })
  .superRefine((caps, ctx) => {
    if (caps.perCall < 1) ctx.addIssue({ code: 'custom', path: ['perCall'], message: 'perCall must be at least 1' });
    if (caps.perCall > caps.unsettled) {
      ctx.addIssue({ code: 'custom', path: ['unsettled'], message: 'unsettled must be at least perCall' });
    }
    if (caps.perCall > caps.daily) ctx.addIssue({ code: 'custom', path: ['daily'], message: 'daily must be at least perCall' });
    if (caps.total !== undefined && caps.total !== null && caps.total < caps.perCall) {
      ctx.addIssue({ code: 'custom', path: ['total'], message: 'total must be at least perCall' });
    }
  });

/** Write endpoints without a body accept nothing, or an empty object. */
export const emptyBody = z.union([z.undefined(), z.strictObject({})]);

export function loadOperator(ctx: ServiceContext, operatorId: string): OperatorRow {
  const operator = ctx.db.prepare('SELECT * FROM operators WHERE id = ?').get(operatorId) as OperatorRow | undefined;
  if (!operator) throw notFound('Operator not found');
  return operator;
}

/** Maps a PayPal failure during a wallet call to 502; anything else propagates. */
export function paypalFailure(err: unknown): never {
  if (err instanceof PayPalApiError || err instanceof PayPalNetworkError) {
    throw new HttpError(502, 'paypal_unavailable', 'PayPal could not complete the request; try again');
  }
  throw err;
}

/** `/v1/operator` (design spec §7.2). */
export function operatorRoutes(ctx: ServiceContext, wallets: WalletService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const operatorId = authOf(res).ownerId;
    const operator = loadOperator(ctx, operatorId);
    const now = ctx.clock();
    const snapshot = snapshotSync(ctx.db, operatorId, now);
    const activeAgents = (
      ctx.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE operator_id = ? AND status = 'active'`).get(operatorId) as {
        n: number;
      }
    ).n;
    const last = ctx.db
      .prepare('SELECT * FROM settlements WHERE operator_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(operatorId) as SettlementRow | undefined;
    const counts = ctx.db
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
    const wallet = wallets.get(operatorId);
    res.json({
      operator: { id: operator.id, name: operator.name, email: operator.email, createdAt: operator.created_at },
      wallet: walletView(ctx.db, wallet),
      caps: capsView(operator),
      usage: {
        spentToday: snapshot.spentToday,
        notYetCharged: snapshot.unsettled,
        spentTotal: snapshot.spentTotal,
        notYetChargedCalls: counts.notYetChargedCalls,
        chargeable: counts.chargeable,
        chargeableCalls: counts.chargeableCalls,
        notCollected: counts.notCollected,
        notCollectedCalls: counts.notCollectedCalls,
      },
      activeAgents,
      lastSettlement: last ? settlementView(last) : null,
      blockReason: operatorBlockReason(ctx.db, operator, wallet.status, now),
    });
  });

  router.put('/caps', (req, res) => {
    const operatorId = authOf(res).ownerId;
    loadOperator(ctx, operatorId);
    const body = parse(capsSchema, req.body);
    const caps: Caps = { perCall: body.perCall, daily: body.daily, unsettled: body.unsettled };
    if (body.total !== undefined && body.total !== null) caps.total = body.total;
    try {
      assertValidCaps(caps);
    } catch (err) {
      throw new HttpError(400, 'validation_failed', 'The caps are invalid', [
        { path: '', message: err instanceof Error ? err.message : 'invalid caps' },
      ]);
    }
    ctx.db
      .prepare('UPDATE operators SET cap_per_call = ?, cap_daily = ?, cap_unsettled = ?, cap_total = ? WHERE id = ?')
      .run(caps.perCall, caps.daily, caps.unsettled, caps.total ?? null, operatorId);
    recordAudit(ctx.db, ctx.logger, ctx.clock(), {
      actorType: 'operator',
      actorId: operatorId,
      action: 'operator.caps_updated',
      resourceType: 'operator',
      resourceId: operatorId,
      details: { ...caps },
    });
    res.json({ caps: capsView(loadOperator(ctx, operatorId)) });
  });

  router.post(
    '/wallet/link',
    handler(async (req, res) => {
      parse(emptyBody, req.body);
      const operatorId = authOf(res).ownerId;
      loadOperator(ctx, operatorId);
      try {
        res.json(await wallets.startLink(operatorId));
      } catch (err) {
        paypalFailure(err);
      }
    }),
  );

  router.post(
    '/wallet/refresh',
    handler(async (req, res) => {
      parse(emptyBody, req.body);
      const operatorId = authOf(res).ownerId;
      loadOperator(ctx, operatorId);
      if (wallets.relinkPending(operatorId)) {
        throw conflict('settlement_in_progress', 'A settlement for the new wallet is in progress');
      }
      try {
        res.json({ wallet: walletView(ctx.db, await wallets.finish(operatorId)) });
      } catch (err) {
        paypalFailure(err);
      }
    }),
  );

  router.post(
    '/wallet/unlink',
    handler(async (req, res) => {
      parse(emptyBody, req.body);
      const operatorId = authOf(res).ownerId;
      loadOperator(ctx, operatorId);
      const result = await wallets.unlink(operatorId);
      const wallet = walletView(ctx.db, result.wallet);
      if (result.error === 'settlement_failed') {
        res.status(409).json({ error: 'settlement_failed', message: 'The final charge was declined; the wallet stays linked', wallet });
        return;
      }
      if (result.error === 'settlement_in_progress') {
        res.status(409).json({
          error: 'settlement_in_progress',
          message: 'The final charge is still in progress; the wallet unlinks when it completes',
          wallet,
        });
        return;
      }
      res.json({ wallet });
    }),
  );

  return router;
}
