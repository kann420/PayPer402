import { PayPalApiError, PayPalNetworkError } from '@payper402/paypal-client';
import type { LogLevel } from './config';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One JSON line per entry on stdout/stderr. Callers pass only non-secret fields: ids, statuses,
 * PayPal debug ids. Never API keys, vault ids, tokens or the client secret.
 */
export function createLogger(level: LogLevel, now: () => Date = () => new Date()): Logger {
  const write = (entryLevel: LogLevel, message: string, fields?: LogFields) => {
    if (ORDER[entryLevel] < ORDER[level]) return;
    const line = JSON.stringify({ time: now().toISOString(), level: entryLevel, message, ...fields });
    if (entryLevel === 'error' || entryLevel === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

/** A logger that drops everything, for tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A loggable description of an error. PayPal errors are reduced to status, name, issues and debug
 * id: never their path or PayPal's message, which could carry a payment token id.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof PayPalApiError) {
    const issues = err.issues.length > 0 ? ` [${err.issues.join(',')}]` : '';
    return `PayPal HTTP ${err.httpStatus} ${err.name}${issues}${err.debugId ? ` debug_id=${err.debugId}` : ''}`;
  }
  if (err instanceof PayPalNetworkError) return 'PayPal network error';
  return err instanceof Error ? err.message : String(err);
}

/** Structured, non-secret fields of an error, for logs and audit details. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof PayPalApiError) {
    return { errorClass: 'PayPalApiError', httpStatus: err.httpStatus, name: err.name, issues: err.issues.join(','), debugId: err.debugId };
  }
  if (err instanceof PayPalNetworkError) return { errorClass: 'PayPalNetworkError' };
  return { errorClass: err instanceof Error ? err.constructor.name : typeof err };
}
