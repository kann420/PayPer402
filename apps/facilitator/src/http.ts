import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { randomToken } from './crypto';
import { errorMessage, type Logger } from './logger';

const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** An error with an HTTP status and a snake_case code, rendered as `{ error, message }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[] | undefined;

  constructor(status: number, code: string, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** Echoes a well-formed client `X-Request-Id`, otherwise generates one (design spec §7). */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming && CLIENT_REQUEST_ID.test(incoming) ? incoming : `req_${randomToken(12)}`;
  res.locals['requestId'] = id;
  res.setHeader('X-Request-Id', id);
  next();
};

/** Parses `value` with `schema`, or throws a 400 `validation_failed` with issues. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    'validation_failed',
    'The request is invalid',
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

/** Express 5 forwards rejected promises, but this keeps handler types simple. */
export function handler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound());
};

interface BodyParserError {
  type?: unknown;
  status?: unknown;
}

/** Terminal error handler. Never exposes stack traces or internal messages. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...(err.issues === undefined ? {} : { issues: err.issues }),
      });
      return;
    }
    const parserError = err as BodyParserError;
    if (typeof parserError?.type === 'string' && typeof parserError.status === 'number') {
      if (parserError.type === 'entity.too.large') {
        res.status(413).json({ error: 'payload_too_large', message: 'The request body is too large' });
        return;
      }
      if (parserError.status === 400) {
        res.status(400).json({ error: 'validation_failed', message: 'The request body is not valid JSON', issues: [] });
        return;
      }
    }
    logger.error('Unhandled request error', {
      requestId: String(res.locals['requestId'] ?? ''),
      method: req.method,
      path: req.path,
      error: errorMessage(err),
    });
    res.status(500).json({ error: 'internal_error', message: 'Internal error' });
  };
}
