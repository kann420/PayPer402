import type { KeyObject } from 'node:crypto';
import { parseArgs } from 'node:util';
import { importPrivateKeyJwk, importPrivateKeyRaw, isValidCents, priceToCents, type Ed25519PrivateJwk } from '@payper402/scheme-paypal';
import { DEFAULT_MODEL } from './agent';

export const DEFAULT_TASK = "Brief me on today's coffee market: current price, top news, and a summary in Vietnamese.";
export const DEFAULT_SELLER_URL = 'http://localhost:4021';
export const DEFAULT_BUDGET = '1.00';
export const DEFAULT_MAX_PER_CALL = '0.10';

export interface AgentConfig {
  privateKey: KeyObject;
  sellerUrl: string;
  budgetCents: number;
  maxPerCallCents: number;
  model: string;
  task: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Imports `AGENT_PRIVATE_KEY`: the raw 32-byte seed in base64url (a JWK's `d`), or a JSON JWK.
 * Errors never echo the value.
 */
export function parseAgentKey(value: string): KeyObject {
  const trimmed = value.trim();
  try {
    if (trimmed.startsWith('{')) {
      const jwk = JSON.parse(trimmed) as Partial<Ed25519PrivateJwk>;
      if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string' || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
        throw new Error('incomplete JWK');
      }
      return importPrivateKeyJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });
    }
    return importPrivateKeyRaw(trimmed);
  } catch {
    throw new ConfigError('AGENT_PRIVATE_KEY must be an Ed25519 private key: a 32-byte seed in base64url, or a JSON JWK');
  }
}

function dollars(name: string, value: string): number {
  let cents: number;
  try {
    cents = priceToCents(value);
  } catch {
    throw new ConfigError(`${name} must be a dollar amount such as 1.00`);
  }
  if (!isValidCents(cents)) throw new ConfigError(`${name} must be a dollar amount such as 1.00`);
  return cents;
}

function httpUrl(name: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return value.replace(/\/+$/, '');
  } catch {
    // Falls through to the error below.
  }
  throw new ConfigError(`${name} must be an http(s) URL`);
}

const env = (vars: Record<string, string | undefined>, name: string) => {
  const value = vars[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/**
 * Reads the CLI and MCP configuration (design spec §7): the environment, overridden by
 * `--budget` and `--max-per-call`; the positional words are the task.
 */
export function loadAgentConfig(vars: Record<string, string | undefined>, argv: string[] = []): AgentConfig {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : 'Invalid arguments');
  }
  const keyValue = env(vars, 'AGENT_PRIVATE_KEY');
  if (keyValue === undefined) {
    throw new ConfigError('AGENT_PRIVATE_KEY is required: the agent Ed25519 private key (base64url seed or JSON JWK)');
  }
  const privateKey = parseAgentKey(keyValue);
  const budgetCents = dollars(parsed.values.budget === undefined ? 'AGENT_BUDGET' : '--budget', parsed.values.budget ?? env(vars, 'AGENT_BUDGET') ?? DEFAULT_BUDGET);
  const maxPerCallCents = dollars(
    parsed.values['max-per-call'] === undefined ? 'AGENT_MAX_PER_CALL' : '--max-per-call',
    parsed.values['max-per-call'] ?? env(vars, 'AGENT_MAX_PER_CALL') ?? DEFAULT_MAX_PER_CALL,
  );
  if (maxPerCallCents > budgetCents) throw new ConfigError('The per-call limit must not exceed the budget');
  const task = parsed.positionals.join(' ').trim();
  return {
    privateKey,
    sellerUrl: httpUrl('SELLER_URL', env(vars, 'SELLER_URL') ?? DEFAULT_SELLER_URL),
    budgetCents,
    maxPerCallCents,
    model: env(vars, 'ANTHROPIC_MODEL') ?? DEFAULT_MODEL,
    task: task === '' ? DEFAULT_TASK : task,
  };
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { budget: { type: 'string' }, 'max-per-call': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
}
