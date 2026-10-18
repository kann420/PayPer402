/**
 * Web app configuration (design spec §3.1), validated with zod on first use. A missing required
 * variable makes the affected route answer 503; values are never printed.
 */
import { brand, hasBrand, WEB_CONFIG_ERROR } from './brand';
import 'server-only';
import { z } from 'zod';

export class WebConfigError extends Error {
  override readonly name = 'WebConfigError';
  /** The variable names that are missing or invalid. */
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Missing or invalid configuration: ${variables.join(', ')}`);
    brand(this, WEB_CONFIG_ERROR);
    this.variables = variables;
  }
}

/** `instanceof WebConfigError` across server chunks (see `brand.ts`). */
export function isWebConfigError(value: unknown): value is WebConfigError {
  return hasBrand(value, WEB_CONFIG_ERROR);
}

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const url = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .default(fallback)
      .refine((value) => {
        try {
          const u = new URL(value);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'must be an http(s) URL')
      .transform((value) => value.replace(/\/+$/, '')),
  );

const optional = z.preprocess(blankToUndefined, z.string().trim().optional());
const limit = (fallback: number) => z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(1_000_000).default(fallback));

const schema = z.object({
  WEB_PUBLIC_URL: url('http://localhost:3000'),
  FACILITATOR_URL: url('http://localhost:4020'),
  SELLER_URL: url('http://localhost:4021'),
  FACILITATOR_ADMIN_KEY: optional,
  WEB_SELLER_API_KEY: optional,
  WEB_SESSION_SECRET: optional.refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), 'must be 64 hex characters'),
  ANTHROPIC_MODEL: z.preprocess(blankToUndefined, z.string().trim().default('claude-opus-5-5')),
  TYPESAFE_API_KEY: optional,
  WEB_DECISION_LAYER: z.preprocess(blankToUndefined, z.enum(['on', 'off']).default('on')),
  AG_STUDIO_LICENSE_KEY: optional,
  WEB_TRUST_PROXY: z.preprocess(blankToUndefined, z.enum(['0', '1']).default('0')),
  WEB_LIMIT_OPERATORS_PER_HOUR: limit(5),
  WEB_LIMIT_OPERATORS_PER_DAY: limit(200),
  WEB_LIMIT_RUNS_PER_DAY: limit(20),
  WEB_LIMIT_RUNS_PER_HOUR: limit(60),
  WEB_LIMIT_AI_TURNS_PER_HOUR: limit(120),
  WEB_LIMIT_AI_TURNS_PER_DAY: limit(2000),
});

export interface WebConfig {
  publicUrl: string;
  publicOrigin: string;
  secure: boolean;
  facilitatorUrl: string;
  sellerUrl: string;
  adminKey: string | undefined;
  sellerKey: string | undefined;
  /** 32 bytes; undefined when unset (the session routes then answer 503). */
  sessionSecret: Buffer | undefined;
  model: string;
  typesafeApiKey: string | undefined;
  decisionLayer: boolean;
  agStudioLicenseKey: string | undefined;
  trustProxy: boolean;
  limits: {
    operatorsPerHour: number;
    operatorsPerDay: number;
    runsPerDay: number;
    runsPerHour: number;
    aiTurnsPerHour: number;
    aiTurnsPerDay: number;
  };
}

export function parseWebConfig(env: Record<string, string | undefined>): WebConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new WebConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '(env)')))]);
  const e = parsed.data;
  const origin = new URL(e.WEB_PUBLIC_URL);
  return {
    publicUrl: e.WEB_PUBLIC_URL,
    publicOrigin: origin.origin,
    secure: origin.protocol === 'https:',
    facilitatorUrl: e.FACILITATOR_URL,
    sellerUrl: e.SELLER_URL,
    adminKey: e.FACILITATOR_ADMIN_KEY,
    sellerKey: e.WEB_SELLER_API_KEY,
    sessionSecret: e.WEB_SESSION_SECRET === undefined ? undefined : Buffer.from(e.WEB_SESSION_SECRET, 'hex'),
    model: e.ANTHROPIC_MODEL,
    typesafeApiKey: e.TYPESAFE_API_KEY,
    decisionLayer: e.WEB_DECISION_LAYER === 'on',
    agStudioLicenseKey: e.AG_STUDIO_LICENSE_KEY,
    trustProxy: e.WEB_TRUST_PROXY === '1',
    limits: {
      operatorsPerHour: e.WEB_LIMIT_OPERATORS_PER_HOUR,
      operatorsPerDay: e.WEB_LIMIT_OPERATORS_PER_DAY,
      runsPerDay: e.WEB_LIMIT_RUNS_PER_DAY,
      runsPerHour: e.WEB_LIMIT_RUNS_PER_HOUR,
      aiTurnsPerHour: e.WEB_LIMIT_AI_TURNS_PER_HOUR,
      aiTurnsPerDay: e.WEB_LIMIT_AI_TURNS_PER_DAY,
    },
  };
}

let cached: WebConfig | undefined;

/** The process configuration, parsed once on first use. */
export function webConfig(): WebConfig {
  cached ??= parseWebConfig(process.env);
  return cached;
}

/** Throws a `WebConfigError` naming `name` when a required value is missing. */
export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new WebConfigError([name]);
  return value;
}
