import { Router } from 'express';
import { utcDayStart } from '@payper402/scheme-paypal';
import { authOf } from '../auth';
import type { CommitmentRow, SellerRow } from '../db/rows';
import { notFound, parse } from '../http';
import type { ServiceContext } from '../services/context';
import { feeShare, sellerCommitmentView } from '../views';
import { commitmentFilter, commitmentQuery, listQuery } from './reads';

/** `/v1/seller` (design spec §7.3). Sellers never see operator data or agent ids. */
export function sellerRoutes(ctx: ServiceContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const sellerId = authOf(res).ownerId;
    const seller = ctx.db.prepare('SELECT * FROM sellers WHERE id = ?').get(sellerId) as SellerRow | undefined;
    if (!seller) throw notFound('Seller not found');
    const dayStart = utcDayStart(ctx.clock());
    const usage = ctx.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN recorded_at >= @dayStart AND recorded_at < @dayEnd THEN amount ELSE 0 END), 0) AS revenueToday,
           COALESCE(SUM(amount), 0) AS revenueTotal,
           COALESCE(SUM(CASE WHEN state IN ('unsettled', 'settling') THEN amount ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN recorded_at >= @dayStart AND recorded_at < @dayEnd THEN 1 ELSE 0 END), 0) AS callsToday,
           COUNT(DISTINCT CASE WHEN recorded_at >= @dayStart AND recorded_at < @dayEnd THEN agent_id END) AS uniqueAgentsToday
         FROM commitments WHERE pay_to = @sellerId`,
      )
      .get({ sellerId, dayStart, dayEnd: dayStart + 86_400 });
    res.json({ seller: { id: seller.id, name: seller.name, createdAt: seller.created_at }, usage });
  });

  router.get('/commitments', (req, res) => {
    const query = parse(commitmentQuery, req.query);
    const { where, params } = commitmentFilter({ column: 'pay_to', value: authOf(res).ownerId }, query);
    const rows = ctx.db
      .prepare(`SELECT c.* FROM commitments c WHERE ${where} ORDER BY c.recorded_at DESC, c.id DESC LIMIT @limit`)
      .all(params) as CommitmentRow[];
    res.json({ commitments: rows.map((row) => sellerCommitmentView(ctx.config.apiKeyPepper, row)) });
  });

  router.get('/settlements', (req, res) => {
    const query = parse(listQuery, req.query);
    const rows = ctx.db
      .prepare(
        `SELECT s.id, s.created_at, s.status, s.amount, s.fee,
           SUM(i.amount) AS seller_amount, COUNT(*) AS seller_calls
         FROM settlement_items i JOIN settlements s ON s.id = i.settlement_id
         WHERE i.pay_to = @sellerId ${query.before === undefined ? '' : 'AND s.created_at < @before'}
         GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC LIMIT @limit`,
      )
      .all({
        sellerId: authOf(res).ownerId,
        limit: query.limit,
        ...(query.before === undefined ? {} : { before: query.before }),
      }) as {
      id: string;
      created_at: number;
      status: string;
      amount: number;
      fee: number | null;
      seller_amount: number;
      seller_calls: number;
    }[];
    res.json({
      settlements: rows.map((row) => {
        const share = feeShare(row.fee, row.seller_amount, row.amount);
        return {
          id: row.id,
          createdAt: row.created_at,
          status: row.status,
          sellerAmount: row.seller_amount,
          sellerCalls: row.seller_calls,
          feeShare: share,
          netShare: share === null ? null : row.seller_amount - share,
        };
      }),
    });
  });

  return router;
}
