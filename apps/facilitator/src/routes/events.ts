import type { RequestHandler } from 'express';
import { authOf, type AuthContext } from '../auth';
import { HttpError } from '../http';
import type { FacilitatorEvent } from '../events';
import type { ServiceContext } from '../services/context';
import { agentRef } from '../views';

export const MAX_STREAMS_PER_KEY = 5;
export const DEFAULT_KEEPALIVE_MS = 15_000;

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

/** Turns an internal event into what `auth` may see, or nothing (design spec §7.6). */
export function frameFor(ctx: ServiceContext, auth: AuthContext, event: FacilitatorEvent): Frame | undefined {
  if (auth.role === 'operator') {
    return event.operatorId === auth.ownerId ? { type: event.type, data: { ...event.data } } : undefined;
  }
  if (event.type === 'commitment.recorded') {
    if (event.data.payTo !== auth.ownerId) return undefined;
    return {
      type: event.type,
      data: {
        id: event.data.id,
        agentRef: agentRef(ctx.config.apiKeyPepper, event.data.agentId),
        path: event.data.path,
        amount: event.data.amount,
        recordedAt: event.data.recordedAt,
      },
    };
  }
  if (event.type === 'settlement.updated') {
    const row = ctx.db
      .prepare(
        `SELECT s.created_at AS createdAt, COALESCE(SUM(i.amount), 0) AS sellerAmount, COUNT(i.commitment_id) AS sellerCalls
         FROM settlements s JOIN settlement_items i ON i.settlement_id = s.id
         WHERE s.id = ? AND i.pay_to = ? GROUP BY s.id`,
      )
      .get(event.data.id, auth.ownerId) as { createdAt: number; sellerAmount: number; sellerCalls: number } | undefined;
    if (!row) return undefined;
    return {
      type: event.type,
      data: { id: event.data.id, status: event.data.status, createdAt: row.createdAt, sellerAmount: row.sellerAmount, sellerCalls: row.sellerCalls },
    };
  }
  return undefined;
}

/** `GET /v1/events`: a filtered server-sent events stream, at most 5 open per key. */
export function eventsHandler(ctx: ServiceContext, keepaliveMs: number = DEFAULT_KEEPALIVE_MS): RequestHandler {
  const openStreams = new Map<string, number>();
  return (req, res) => {
    const auth = authOf(res);
    const open = openStreams.get(auth.keyId) ?? 0;
    if (open >= MAX_STREAMS_PER_KEY) {
      throw new HttpError(429, 'too_many_streams', `At most ${MAX_STREAMS_PER_KEY} event streams per API key`);
    }
    openStreams.set(auth.keyId, open + 1);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    const unsubscribe = ctx.events.subscribe((event) => {
      const frame = frameFor(ctx, auth, event);
      if (frame) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`);
    });
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, keepaliveMs);
    keepalive.unref();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      const remaining = (openStreams.get(auth.keyId) ?? 1) - 1;
      if (remaining <= 0) openStreams.delete(auth.keyId);
      else openStreams.set(auth.keyId, remaining);
    };
    req.on('close', close);
    res.on('close', close);
  };
}
