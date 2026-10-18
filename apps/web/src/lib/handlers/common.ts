/** Shared pieces of the route handlers (design spec §7): errors, bodies, sessions and guards. */
import 'server-only';
import type { z } from 'zod';
import { brand, hasBrand, ROUTE_ERROR } from '../brand';
import { isFacilitatorError } from '../facilitator';
import { sameOrigin } from '../origin';
import { readSession, sessionCookie, type Session } from '../session';
import { isWebConfigError } from '../config';

export const BODY_LIMIT = 16 * 1024;

export class RouteError extends Error {
  override readonly name = 'RouteError';
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    brand(this, ROUTE_ERROR);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** `instanceof RouteError` across server chunks (see `brand.ts`). */
export function isRouteError(value: unknown): value is RouteError {
  return hasBrand(value, ROUTE_ERROR);
}

export function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: code, message, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { 'Cache-Control': 'no-store', ...init.headers } });
}

/** Any thrown error to its answer. Unknown errors are logged without content and become 500. */
export function errorResponse(error: unknown, log: (line: string) => void = (l) => console.error(l)): Response {
  if (isRouteError(error)) return jsonError(error.status, error.code, error.message, error.extra);
  if (isFacilitatorError(error)) return Response.json(error.toJSON(), { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  if (isWebConfigError(error)) {
    log(`[web] configuration missing or invalid: ${error.variables.join(', ')}`);
    return jsonError(503, 'not_configured', 'This part of the demo is not configured.');
  }
  log(`[web] unexpected error: ${error instanceof Error ? error.name : 'unknown'}`);
  return jsonError(500, 'internal_error', 'Something went wrong. Try again in a moment.');
}

/** Reads and validates a JSON body: at most `limit` bytes, strict schema. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S, limit = BODY_LIMIT): Promise<z.output<S>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw new RouteError(413, 'payload_too_large', 'The request body is too large.');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw new RouteError(413, 'payload_too_large', 'The request body is too large.');
  let value: unknown;
  try {
    value = text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new RouteError(400, 'validation_failed', 'The request body is not valid JSON.', { issues: [] });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteError(400, 'validation_failed', 'The request is invalid.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

/** The same-origin check for state-changing routes (design spec §15.2). */
export function checkOrigin(request: Request, publicOrigin: string): void {
  if (!sameOrigin(request, publicOrigin)) throw new RouteError(403, 'forbidden', 'This request must come from the PayPer402 web app.');
}

export function sessionOf(request: Request, key: Buffer): Session | undefined {
  return readSession(request, key);
}

/** A session holding an operator, or 401 `no_session` (design spec §4.3). */
export function requireOperator(request: Request, key: Buffer): Session & { operator: NonNullable<Session['operator']> } {
  const session = readSession(request, key);
  if (session?.operator === undefined) throw new RouteError(401, 'no_session', 'Start a demo session first.');
  return session as Session & { operator: NonNullable<Session['operator']> };
}

/** Any valid session, or 401 `no_session`. */
export function requireSession(request: Request, key: Buffer): Session {
  const session = readSession(request, key);
  if (session === undefined) throw new RouteError(401, 'no_session', 'Start a demo session first.');
  return session;
}

/** `scope=operator` needs an operator; `scope=seller` any valid session (design spec §4.3). */
export function requireScope(request: Request, key: Buffer): { scope: 'operator' | 'seller'; session: Session } {
  const scope = new URL(request.url).searchParams.get('scope');
  if (scope !== 'operator' && scope !== 'seller') throw new RouteError(400, 'validation_failed', 'scope must be operator or seller.');
  const session = scope === 'operator' ? requireOperator(request, key) : requireSession(request, key);
  return { scope, session };
}

export function withCookie(response: Response, session: Session, key: Buffer, secure: boolean): Response {
  response.headers.append('Set-Cookie', sessionCookie(session, key, secure));
  return response;
}
