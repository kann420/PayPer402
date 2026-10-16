import type { Request, RequestHandler } from 'express';
import { recordAudit } from '../audit';
import { handler, HttpError } from '../http';
import { errorMessage } from '../logger';
import type { ServiceContext } from '../services/context';
import type { SettlementService } from '../services/settlements';
import type { WalletService } from '../services/wallets';

function flatHeaders(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * `POST /webhooks/paypal` (design spec §11). Mount it with `express.raw` before the JSON parser,
 * so `req.body` is the raw bytes PayPal sent.
 */
export function webhookHandler(ctx: ServiceContext, wallets: WalletService, settlements: SettlementService): RequestHandler {
  return handler(async (req, res) => {
    const webhookId = ctx.config.paypalWebhookId;
    if (!webhookId) throw new HttpError(503, 'webhooks_disabled', 'PAYPAL_WEBHOOK_ID is not configured');
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const headers = flatHeaders(req);
    const transmissionId = headers['paypal-transmission-id'];

    const verified = await ctx.paypal.verifyWebhookSignature({ headers, rawBody, webhookId });
    if (!verified) {
      ctx.logger.warn('Webhook signature verification failed', { transmissionId });
      recordAudit(ctx.db, ctx.logger, ctx.clock(), {
        actorType: 'paypal',
        action: 'webhook.signature_failed',
        resourceType: 'webhook',
        ...(transmissionId === undefined ? {} : { resourceId: transmissionId }),
      });
      throw new HttpError(400, 'invalid_signature', 'Webhook signature verification failed');
    }

    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(rawBody));
    } catch {
      event = undefined;
    }
    const eventId = event?.['id'];
    const eventType = event?.['event_type'];
    if (!event || typeof eventId !== 'string' || typeof eventType !== 'string') {
      throw new HttpError(400, 'validation_failed', 'The webhook event has no id or event_type', []);
    }
    const resource = asRecord(event['resource']) ?? {};
    const rawResourceId = typeof resource['id'] === 'string' ? resource['id'] : null;
    // A vault event's resource id is a payment token id: store only its lookup hash.
    const resourceId =
      rawResourceId !== null && eventType.startsWith('VAULT.') ? ctx.box.lookupHash(rawResourceId) : rawResourceId;

    const inserted = ctx.db
      .prepare(
        `INSERT INTO webhook_events (id, event_type, resource_id, received_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(eventId, eventType, resourceId, ctx.clock());
    if (inserted.changes === 0) {
      res.json({ ok: true, duplicate: true });
      return;
    }

    let outcome: string;
    try {
      outcome = await handleEvent(ctx, wallets, settlements, eventType, resource, eventId);
    } catch (err) {
      ctx.logger.error('Webhook handling failed', { eventId, eventType, error: errorMessage(err) });
      outcome = `error: ${errorMessage(err)}`.slice(0, 500);
    }
    ctx.db.prepare('UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE id = ?').run(ctx.clock(), outcome, eventId);
    res.json({ ok: true });
  });
}

async function handleEvent(
  ctx: ServiceContext,
  wallets: WalletService,
  settlements: SettlementService,
  eventType: string,
  resource: Record<string, unknown>,
  eventId: string,
): Promise<string> {
  switch (eventType) {
    case 'VAULT.PAYMENT-TOKEN.DELETED': {
      const vaultId = resource['id'];
      return typeof vaultId === 'string' ? wallets.revokeByVaultId(vaultId) : 'missing_resource_id';
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.DECLINED':
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.PENDING':
      return settlements.applyCaptureWebhook(eventType, resource);
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
      recordAudit(ctx.db, ctx.logger, ctx.clock(), {
        actorType: 'paypal',
        action: eventType === 'PAYMENT.CAPTURE.REFUNDED' ? 'capture.refunded' : 'capture.reversed',
        resourceType: 'capture',
        ...(typeof resource['id'] === 'string' ? { resourceId: resource['id'] } : {}),
        details: { eventId },
      });
      return 'audited';
    default:
      return 'ignored';
  }
}
