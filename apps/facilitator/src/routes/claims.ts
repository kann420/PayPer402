import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit';
import { claimCodeHash, normaliseClaimCode } from '../claims';
import type { AgentRow } from '../db/rows';
import { conflict, HttpError, parse, type ValidationIssue } from '../http';
import type { ServiceContext } from '../services/context';
import { agentView } from '../views';
import { insertAgent, kidOrThrow } from './agents';
import { loadOperator } from './operator';

const redeemSchema = z.strictObject({ code: z.string().max(40), publicKeyX: z.string().max(100) });

interface ClaimRow {
  id: string;
  operator_id: string;
  agent_name: string;
  seller_url: string | null;
  expires_at: number;
  redeemed_at: number | null;
}

/** `/v1/claims` (operator-cli.md §3.4). Unauthenticated: the claim code is the credential. */
export function claimRoutes(ctx: ServiceContext): Router {
  const router = Router();

  router.post('/redeem', (req, res) => {
    const body = parse(redeemSchema, req.body);
    const normalised = normaliseClaimCode(body.code);
    const issues: ValidationIssue[] = [];
    if (normalised === undefined) issues.push({ path: 'code', message: 'code must be a claim code such as ABCD-EFGH-JKMN' });
    let kid: string | undefined;
    try {
      kid = kidOrThrow(body.publicKeyX);
    } catch (err) {
      if (err instanceof HttpError && err.issues) issues.push(...err.issues);
      else throw err;
    }
    if (normalised === undefined || kid === undefined) {
      throw new HttpError(400, 'validation_failed', 'The request is invalid', issues);
    }
    const agentKid = kid;

    const redeemed = ctx.db
      .transaction(() => {
        const claim = ctx.db
          .prepare('SELECT * FROM agent_claims WHERE code_hash = ?')
          .get(claimCodeHash(ctx.config.apiKeyPepper, normalised)) as ClaimRow | undefined;
        if (!claim) throw new HttpError(404, 'claim_not_found', 'That claim code is not valid');
        if (claim.redeemed_at !== null) throw conflict('claim_used', 'That claim code was already used');
        const now = ctx.clock();
        if (now >= claim.expires_at) throw new HttpError(410, 'claim_expired', 'That claim code has expired');
        const agentId = insertAgent(ctx, {
          operatorId: claim.operator_id,
          name: claim.agent_name,
          kid: agentKid,
          publicKeyX: body.publicKeyX,
          auditDetails: { generatedKey: false, via: 'claim', claimId: claim.id },
        });
        const updated = ctx.db
          .prepare('UPDATE agent_claims SET redeemed_at = ?, agent_id = ? WHERE id = ? AND redeemed_at IS NULL')
          .run(now, agentId, claim.id);
        if (updated.changes !== 1) throw conflict('claim_used', 'That claim code was already used');
        recordAudit(ctx.db, ctx.logger, now, {
          actorType: 'system',
          actorId: 'claim',
          action: 'agent.claim_redeemed',
          resourceType: 'agent_claim',
          resourceId: claim.id,
          details: { agentId },
        });
        return { agentId, claim };
      })
      .immediate();

    const { agentId, claim } = redeemed;
    ctx.events.emit({ type: 'agent.updated', operatorId: claim.operator_id, data: { id: agentId, status: 'active' } });
    const agent = ctx.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow;
    res.status(201).json({
      agent: agentView(agent),
      operator: { name: loadOperator(ctx, claim.operator_id).name },
      sellerUrl: claim.seller_url,
    });
  });

  return router;
}
