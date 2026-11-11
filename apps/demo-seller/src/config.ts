import { z } from 'zod';

export interface SellerConfig {
  port: number;
  /** External base URL, without a trailing slash. Reserved for links; no route uses it yet. */
  publicUrl: string;
  /** The facilitator's base URL, without a trailing slash. */
  facilitatorUrl: string;
  sellerApiKey: string;
  anthropicModel: string;
}

const optional = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const httpUrl = (name: string) =>
  z
    .string()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, `${name} must be an http(s) URL`)
    .transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
  SELLER_PORT: optional
    .transform((value) => value ?? '4021')
    .pipe(z.string().regex(/^[0-9]{1,5}$/, 'must be a port number'))
    .transform(Number)
    .refine((port) => port >= 0 && port <= 65_535, 'must be a port number'),
  SELLER_PUBLIC_URL: optional.pipe(httpUrl('SELLER_PUBLIC_URL').optional()),
  FACILITATOR_URL: optional.transform((value) => value ?? 'http://localhost:4020').pipe(httpUrl('FACILITATOR_URL')),
  SELLER_API_KEY: optional.pipe(z.string({ error: 'is required' }).regex(/^pp402_sel_[A-Za-z0-9_-]{43}$/, 'must be a seller key (pp402_sel_…)')),
  ANTHROPIC_MODEL: optional.transform((value) => value ?? 'claude-opus-5-5'),
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
 * Validates the environment (design spec §3.1). Throws a `ConfigError` that names each invalid
 * variable but never echoes a value.
 */
export function loadSellerConfig(env: Record<string, string | undefined>): SellerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`));
  }
  const e = parsed.data;
  return {
    port: e.SELLER_PORT,
    publicUrl: e.SELLER_PUBLIC_URL ?? `http://localhost:${e.SELLER_PORT}`,
    facilitatorUrl: e.FACILITATOR_URL,
    sellerApiKey: e.SELLER_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
  };
}
