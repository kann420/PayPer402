import { Router } from 'express';
import { agentOf } from '../agent-auth';
import type { ServiceContext } from '../services/context';
import type { WalletService } from '../services/wallets';
import { agentWithUsage, capsView, operatorUsage, walletView } from '../views';
import { loadOperator } from './operator';

/** `/v1/agent` (operator-cli.md §4.4): a read-only, least-privilege view for the signing agent. */
export function agentStatusRoutes(ctx: ServiceContext, wallets: WalletService): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    const agent = agentOf(res);
    const operator = loadOperator(ctx, agent.operator_id);
    const wallet = wallets.get(operator.id);
    const now = ctx.clock();
    const own = agentWithUsage(ctx.db, agent, operator, wallet.status, now);
    const usage = operatorUsage(ctx.db, operator.id, now);
    const caps = capsView(operator);
    const walletInfo = walletView(ctx.db, wallet);
    res.json({
      agent: {
        id: own.id,
        name: own.name,
        keyFingerprint: own.keyFingerprint,
        status: own.status,
        createdAt: own.createdAt,
        spentToday: own.spentToday,
        spentTotal: own.spentTotal,
        callsToday: own.callsToday,
        lastCallAt: own.lastCallAt,
      },
      operator: { name: operator.name },
      wallet: {
        status: walletInfo.status,
        stoppedAt: walletInfo.stoppedAt,
        lastChargeAt: walletInfo.lastChargeAt,
        lastChargeAmount: walletInfo.lastChargeAmount,
        lastChargeStatus: walletInfo.lastChargeStatus,
      },
      caps,
      usage: {
        spentToday: usage.spentToday,
        notYetCharged: usage.notYetCharged,
        notYetChargedCalls: usage.notYetChargedCalls,
        spentTotal: usage.spentTotal,
      },
      remainingToday: Math.max(0, caps.daily - usage.spentToday),
      blocked: own.blocked,
      blockReason: own.blockReason,
    });
  });

  return router;
}
