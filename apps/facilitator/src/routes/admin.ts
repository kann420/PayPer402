import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit';
import { issueApiKey } from '../auth';
import { randomId } from '../crypto';
import { HttpError, parse } from '../http';
import { DEMO_OPERATOR } from '../seed';
import type { ServiceContext } from '../services/context';

/**
 * The default name differs from the seed's demo operator on purpose: `seed()` finds its operator by
 * name, and `seed --reset` deletes whatever that lookup returns.
 */
export const DEMO_OPERATOR_NAME = 'Northwind Research (demo)';
export const DEMO_OPERATOR_KEY_LABEL = 'web-demo';

const bodySchema = z.union([
  z.undefined(),
  z.strictObject({ name: z.string().trim().min(1).max(60).optional() }),
]);

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** `Authorization: Bearer <ADMIN_API_KEY>`, compared as SHA-256 digests in constant time. */
function adminAuth(adminKey: string): RequestHandler {
  const expected = digest(adminKey);
  return (req, _res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '');
    const given = match?.[1];
    if (given === undefined || !timingSafeEqual(digest(given), expected)) {
      next(new HttpError(401, 'unauthorized', 'Missing or invalid API key'));
      return;
    }
    next();
  };
}

/** `/v1/admin` (web-app spec §5.1). Mounted only when `ADMIN_API_KEY` is set. */
export function adminRoutes(ctx: ServiceContext, adminKey: string): Router {
  const router = Router();
  router.use(adminAuth(adminKey));

  router.post('/demo-operators', (req, res) => {
    const body = parse(bodySchema, req.body);
    const name = body?.name ?? DEMO_OPERATOR_NAME;
    const now = ctx.clock();
    const { caps } = DEMO_OPERATOR;
    const operatorId = randomId('op');
    const apiKey = ctx.db
      .transaction(() => {
        ctx.db
          .prepare(
            `INSERT INTO operators (id, name, email, cap_per_call, cap_daily, cap_unsettled, cap_total, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(operatorId, name, caps.perCall, caps.daily, caps.unsettled, caps.total, now);
        ctx.db.prepare(`INSERT INTO wallets (operator_id, status, updated_at) VALUES (?, 'not_linked', ?)`).run(operatorId, now);
        const key = issueApiKey(ctx.db, ctx.config.apiKeyPepper, 'operator', operatorId, DEMO_OPERATOR_KEY_LABEL, now);
        recordAudit(ctx.db, ctx.logger, now, {
          actorType: 'system',
          actorId: 'admin',
          action: 'operator.demo_created',
          resourceType: 'operator',
          resourceId: operatorId,
        });
        return key;
      })
      .immediate();
    res.status(201).json({ operator: { id: operatorId, name }, apiKey });
  });

  return router;
}
