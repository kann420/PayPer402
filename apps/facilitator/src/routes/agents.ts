import { Router } from 'express';
import { exportPrivateKeyJwk, generateAgentKey, kidFromPublicKeyX } from '@payper402/scheme-paypal';
import { z } from 'zod';
import { recordAudit } from '../audit';
import { authOf } from '../auth';
import { randomId } from '../crypto';
import type { AgentRow } from '../db/rows';
import { conflict, HttpError, notFound, parse } from '../http';
import type { ServiceContext } from '../services/context';
import type { WalletService } from '../services/wallets';
import { agentView, agentWithUsage } from '../views';
import { loadOperator } from './operator';

const nameSchema = z.string().trim().min(1).max(100);

const createSchema = z.strictObject({
  name: nameSchema,
  publicKeyX: z.string().min(1).max(100).optional(),
});

const patchSchema = z
  .strictObject({ name: nameSchema.optional(), status: z.enum(['active', 'paused']).optional() })
  .refine((body) => body.name !== undefined || body.status !== undefined, 'Nothing to update');

/** `/v1/agents` (design spec §7.2, §7.4). */
export function agentRoutes(ctx: ServiceContext, wallets: WalletService): Router {
  const router = Router();

  const loadAgent = (operatorId: string, id: string): AgentRow => {
    const row = ctx.db.prepare('SELECT * FROM agents WHERE id = ? AND operator_id = ?').get(id, operatorId) as
      | AgentRow
      | undefined;
    if (!row) throw notFound('Agent not found');
    return row;
  };

  const withUsage = (operatorId: string, rows: AgentRow[]) => {
    const operator = loadOperator(ctx, operatorId);
    const walletStatus = wallets.get(operatorId).status;
    const now = ctx.clock();
    return rows.map((row) => agentWithUsage(ctx.db, row, operator, walletStatus, now));
  };

  router.post('/', (req, res) => {
    const operatorId = authOf(res).ownerId;
    loadOperator(ctx, operatorId);
    const body = parse(createSchema, req.body);
    let publicKeyX: string;
    let kid: string;
    let privateKeyJwk: ReturnType<typeof exportPrivateKeyJwk> | undefined;
    if (body.publicKeyX !== undefined) {
      try {
        kid = kidFromPublicKeyX(body.publicKeyX);
      } catch {
        throw new HttpError(400, 'validation_failed', 'The request is invalid', [
          { path: 'publicKeyX', message: 'publicKeyX must be a raw Ed25519 public key (32 bytes, base64url)' },
        ]);
      }
      publicKeyX = body.publicKeyX;
    } else {
      const key = generateAgentKey();
      publicKeyX = key.publicKeyX;
      kid = key.kid;
      privateKeyJwk = exportPrivateKeyJwk(key.privateKey);
    }
    if (ctx.db.prepare('SELECT 1 FROM agents WHERE kid = ?').get(kid)) {
      throw conflict('agent_key_exists', 'An agent with this key already exists');
    }
    const now = ctx.clock();
    const id = randomId('agt');
    ctx.db
      .prepare(
        `INSERT INTO agents (id, operator_id, name, kid, public_key_x, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(id, operatorId, body.name, kid, publicKeyX, now);
    recordAudit(ctx.db, ctx.logger, now, {
      actorType: 'operator',
      actorId: operatorId,
      action: 'agent.created',
      resourceType: 'agent',
      resourceId: id,
      details: { generatedKey: privateKeyJwk !== undefined },
    });
    ctx.events.emit({ type: 'agent.updated', operatorId, data: { id, status: 'active' } });
    const agent = agentView(loadAgent(operatorId, id));
    res.status(201).json(privateKeyJwk ? { agent, privateKeyJwk } : { agent });
  });

  router.get('/', (_req, res) => {
    const operatorId = authOf(res).ownerId;
    const rows = ctx.db
      .prepare('SELECT * FROM agents WHERE operator_id = ? ORDER BY created_at DESC, id DESC')
      .all(operatorId) as AgentRow[];
    res.json({ agents: withUsage(operatorId, rows) });
  });

  router.get('/:id', (req, res) => {
    const operatorId = authOf(res).ownerId;
    const [agent] = withUsage(operatorId, [loadAgent(operatorId, req.params['id'] ?? '')]);
    res.json({ agent });
  });

  router.patch('/:id', (req, res) => {
    const operatorId = authOf(res).ownerId;
    const current = loadAgent(operatorId, req.params['id'] ?? '');
    const body = parse(patchSchema, req.body);
    ctx.db
      .prepare('UPDATE agents SET name = ?, status = ? WHERE id = ?')
      .run(body.name ?? current.name, body.status ?? current.status, current.id);
    const updated = loadAgent(operatorId, current.id);
    if (updated.status !== current.status) {
      recordAudit(ctx.db, ctx.logger, ctx.clock(), {
        actorType: 'operator',
        actorId: operatorId,
        action: updated.status === 'paused' ? 'agent.paused' : 'agent.resumed',
        resourceType: 'agent',
        resourceId: current.id,
      });
    }
    ctx.events.emit({ type: 'agent.updated', operatorId, data: { id: updated.id, status: updated.status } });
    const [agent] = withUsage(operatorId, [updated]);
    res.json({ agent });
  });

  return router;
}
