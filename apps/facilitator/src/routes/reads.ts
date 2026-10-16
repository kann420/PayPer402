import { Router } from 'express';
import { z } from 'zod';
import { authOf } from '../auth';
import type { CommitmentRow, SettlementRow } from '../db/rows';
import { handler, notFound, parse } from '../http';
import type { ServiceContext } from '../services/context';
import type { SettlementService } from '../services/settlements';
import { commitmentView, settlementView } from '../views';
import { emptyBody } from './operator';

const unix = z.coerce.number().int().nonnegative();

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  before: unix.optional(),
});

export const commitmentQuery = listQuery.extend({
  agentId: z.string().min(1).max(100).optional(),
  state: z.enum(['unsettled', 'settling', 'settled', 'uncollectable']).optional(),
  since: unix.optional(),
  until: unix.optional(),
});

export type CommitmentQuery = z.output<typeof commitmentQuery>;

/**
 * Builds the WHERE clause for a commitment list. `since` is inclusive and `until` exclusive, both
 * over `recorded_at`; `before` is a `recordedAt` cursor (exclusive). Newest first.
 */
export function commitmentFilter(scope: { column: string; value: string }, query: CommitmentQuery) {
  const clauses = [`c.${scope.column} = @scope`];
  const params: Record<string, string | number> = { scope: scope.value, limit: query.limit };
  if (query.agentId !== undefined) {
    clauses.push('c.agent_id = @agentId');
    params['agentId'] = query.agentId;
  }
  if (query.state !== undefined) {
    clauses.push('c.state = @state');
    params['state'] = query.state;
  }
  if (query.since !== undefined) {
    clauses.push('c.recorded_at >= @since');
    params['since'] = query.since;
  }
  if (query.until !== undefined) {
    clauses.push('c.recorded_at < @until');
    params['until'] = query.until;
  }
  if (query.before !== undefined) {
    clauses.push('c.recorded_at < @before');
    params['before'] = query.before;
  }
  return { where: clauses.join(' AND '), params };
}

/** `/v1/commitments` and `/v1/settlements` for operators (design spec §7.2). */
export function readRoutes(ctx: ServiceContext, settlements: SettlementService): { commitments: Router; settlements: Router } {
  const commitmentsRouter = Router();
  const settlementsRouter = Router();

  commitmentsRouter.get('/', (req, res) => {
    const query = parse(commitmentQuery, req.query);
    const { where, params } = commitmentFilter({ column: 'operator_id', value: authOf(res).ownerId }, query);
    const rows = ctx.db
      .prepare(
        `SELECT c.*, a.name AS agent_name FROM commitments c JOIN agents a ON a.id = c.agent_id
         WHERE ${where} ORDER BY c.recorded_at DESC, c.id DESC LIMIT @limit`,
      )
      .all(params) as (CommitmentRow & { agent_name: string })[];
    res.json({ commitments: rows.map(commitmentView) });
  });

  settlementsRouter.get('/', (req, res) => {
    const query = parse(listQuery, req.query);
    const rows = ctx.db
      .prepare(
        `SELECT * FROM settlements WHERE operator_id = @operatorId ${query.before === undefined ? '' : 'AND created_at < @before'}
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ operatorId: authOf(res).ownerId, limit: query.limit, ...(query.before === undefined ? {} : { before: query.before }) }) as SettlementRow[];
    res.json({ settlements: rows.map(settlementView) });
  });

  settlementsRouter.get('/:id', (req, res) => {
    const row = ctx.db
      .prepare('SELECT * FROM settlements WHERE id = ? AND operator_id = ?')
      .get(req.params['id'] ?? '', authOf(res).ownerId) as SettlementRow | undefined;
    if (!row) throw notFound('Settlement not found');
    const items = ctx.db
      .prepare(
        `SELECT c.*, i.amount AS item_amount, i.pay_to AS item_pay_to, a.name AS agent_name
         FROM settlement_items i JOIN commitments c ON c.id = i.commitment_id JOIN agents a ON a.id = c.agent_id
         WHERE i.settlement_id = ? ORDER BY c.recorded_at DESC, c.id DESC`,
      )
      .all(row.id) as (CommitmentRow & { item_amount: number; item_pay_to: string; agent_name: string })[];
    res.json({
      settlement: {
        ...settlementView(row),
        commitments: items.map((item) => ({ ...commitmentView(item), amount: item.item_amount, payTo: item.item_pay_to })),
      },
    });
  });

  settlementsRouter.post(
    '/',
    handler(async (req, res) => {
      parse(emptyBody, req.body);
      const row = await settlements.settleManually(authOf(res).ownerId);
      res.status(201).json({ settlement: settlementView(row) });
    }),
  );

  return { commitments: commitmentsRouter, settlements: settlementsRouter };
}
