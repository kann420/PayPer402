import { resolveApiBase } from '@payper402/paypal-client';
import { z } from 'zod';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  port: number;
  databasePath: string;
  /** External base URL of this service, without a trailing slash. */
  publicBaseUrl: string;
  /** Where the browser is sent after linking, without a trailing slash. */
  webAppUrl?: string;
  paypalClientId: string;
  paypalClientSecret: string;
  /** Already checked by the sandbox guard. */
  paypalApiBase: string;
  paypalWebhookId?: string;
  /** 32 bytes, from 64 hex characters. */
  dataEncryptionKey: Buffer;
  apiKeyPepper: string;
  /** At least 32 characters. When set, `POST /v1/admin/demo-operators` is mounted (design spec §3). */
  adminApiKey?: string;
  settlementTickSeconds: number;
  walletCheckIntervalSeconds: number;
  /** Whether the rate limits key on the first `X-Forwarded-For` address (operator-cli.md §9.3). */
  trustProxy: boolean;
  logLevel: LogLevel;
}

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const httpUrl = (name: string) =>
  z
    .string()
    .trim()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, `${name} must be an http(s) URL`)
    .transform((value) => value.replace(/\/+$/, ''));

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? String(fallback) : value.trim()))
    .pipe(z.string().regex(/^[1-9][0-9]{0,8}$/, 'must be a positive integer'))
    .transform(Number);

const schema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? '4020' : value.trim()))
    .pipe(z.string().regex(/^[0-9]{1,5}$/, 'must be a port number'))
    .transform(Number)
    .refine((port) => port >= 0 && port <= 65_535, 'must be a port number'),
  DATABASE_PATH: optionalString.transform((value) => value ?? './data/facilitator.db'),
  PUBLIC_BASE_URL: httpUrl('PUBLIC_BASE_URL'),
  WEB_APP_URL: optionalString.pipe(httpUrl('WEB_APP_URL').optional()),
  PAYPAL_CLIENT_ID: z.string().trim().min(1, 'is required'),
  PAYPAL_CLIENT_SECRET: z.string().trim().min(1, 'is required'),
  PAYPAL_API_BASE: optionalString.transform((value, ctx) => {
    try {
      return resolveApiBase(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be the PayPal sandbox host (the live host is refused)' });
      return z.NEVER;
    }
  }),
  PAYPAL_WEBHOOK_ID: optionalString,
  DATA_ENCRYPTION_KEY: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),
  API_KEY_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  ADMIN_API_KEY: optionalString.pipe(z.string().min(32, 'must be at least 32 characters').optional()),
  SETTLEMENT_TICK_SECONDS: positiveInt(15),
  WALLET_CHECK_INTERVAL_SECONDS: positiveInt(30),
  LOG_LEVEL: optionalString.pipe(z.enum(['debug', 'info', 'warn', 'error']).optional()),
  FACILITATOR_TRUST_PROXY: optionalString.pipe(z.enum(['0', '1']).optional()),
});

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.problems = problems;
  }
}

/**
 * Validates the environment (design spec §3). Throws a `ConfigError` that names each invalid
 * variable but never echoes a value.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`));
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    ...(e.WEB_APP_URL === undefined ? {} : { webAppUrl: e.WEB_APP_URL }),
    paypalClientId: e.PAYPAL_CLIENT_ID,
    paypalClientSecret: e.PAYPAL_CLIENT_SECRET,
    paypalApiBase: e.PAYPAL_API_BASE,
    ...(e.PAYPAL_WEBHOOK_ID === undefined ? {} : { paypalWebhookId: e.PAYPAL_WEBHOOK_ID }),
    dataEncryptionKey: Buffer.from(e.DATA_ENCRYPTION_KEY, 'hex'),
    apiKeyPepper: e.API_KEY_PEPPER,
    ...(e.ADMIN_API_KEY === undefined ? {} : { adminApiKey: e.ADMIN_API_KEY }),
    settlementTickSeconds: e.SETTLEMENT_TICK_SECONDS,
    walletCheckIntervalSeconds: e.WALLET_CHECK_INTERVAL_SECONDS,
    trustProxy: e.FACILITATOR_TRUST_PROXY === '1',
    logLevel: e.LOG_LEVEL ?? 'info',
  };
}
