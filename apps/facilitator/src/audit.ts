import type { Db } from './db/connection';
import { errorMessage, type Logger } from './logger';

export const MAX_AUDIT_DETAILS_BYTES = 16 * 1024;

export interface AuditEntry {
  actorType: 'operator' | 'seller' | 'system' | 'paypal';
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}

function serializeDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(details, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  } catch (err) {
    return JSON.stringify({ serializeFailed: true, error: errorMessage(err) });
  }
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_AUDIT_DETAILS_BYTES) return encoded;
  return JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(encoded, 'utf8'), preview: encoded.slice(0, 512) });
}

/** Best-effort audit record: a failure is logged and never breaks the calling action. */
export function recordAudit(db: Db, logger: Logger, now: number, entry: AuditEntry): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      serializeDetails(entry.details),
      now,
    );
  } catch (err) {
    logger.error('Audit write failed', { action: entry.action, error: errorMessage(err) });
  }
}
