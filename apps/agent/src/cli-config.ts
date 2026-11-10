/**
 * The `payper402` config file (operator-cli.md §7): one agent identity per directory, holding the
 * agent's private key. Errors never include file content.
 */
import type { KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { importPrivateKeyRaw, kidFromPublicKeyX, publicKeyX } from '@payper402/scheme-paypal';
import { z } from 'zod';

export const CONFIG_FILE = 'config.json';

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

const cliConfigSchema = z.strictObject({
  version: z.literal(1),
  facilitatorUrl: httpUrl,
  sellerUrl: httpUrl,
  operatorName: z.string().min(1).max(200),
  agent: z.strictObject({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    kid: z.string().min(1).max(100),
    keyFingerprint: z.string().min(1).max(100),
  }),
  privateKey: z.string().min(1).max(100),
  createdAt: z.number().int().nonnegative(),
});

export type CliConfig = z.output<typeof cliConfigSchema>;

export type ReadCliConfig =
  | { ok: true; config: CliConfig; privateKey: KeyObject }
  | { ok: false; reason: 'missing' | 'invalid' };

/** `PAYPER402_HOME` if set, otherwise `~/.payper402`. */
export function configDir(env: Record<string, string | undefined>): string {
  const home = env['PAYPER402_HOME']?.trim();
  return home === undefined || home === '' ? path.join(homedir(), '.payper402') : path.resolve(home);
}

export function configPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), CONFIG_FILE);
}

/**
 * Reads and checks the config: a strict schema, and a private key whose derived `kid` equals the
 * agent's. A missing file is `missing`; anything else wrong is `invalid`.
 */
export async function readCliConfig(env: Record<string, string | undefined>): Promise<ReadCliConfig> {
  let text: string;
  try {
    text = await readFile(configPath(env), 'utf8');
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const parsed = cliConfigSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  try {
    const privateKey = importPrivateKeyRaw(parsed.data.privateKey);
    if (kidFromPublicKeyX(publicKeyX(privateKey)) !== parsed.data.agent.kid) return { ok: false, reason: 'invalid' };
    return { ok: true, config: parsed.data, privateKey };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Moves the current config aside to `config.<label>-<unixSeconds>.json` in the same directory, so a
 * new onboarding never destroys an old key. The rename keeps the file's `0o600` mode. Returns the
 * backup path.
 */
export async function backupCliConfig(env: Record<string, string | undefined>, label: string, nowSeconds: number): Promise<string> {
  const safe = label.replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'agent';
  const backup = path.join(configDir(env), `config.${safe}-${nowSeconds}.json`);
  await rename(configPath(env), backup);
  return backup;
}

/** Writes the config atomically: a `0o700` directory, a `0o600` temporary file, then a rename. */
export async function writeCliConfig(env: Record<string, string | undefined>, config: CliConfig): Promise<void> {
  const file = configPath(env);
  const tmp = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // A stale temporary file would keep its old mode.
    await rm(tmp, { force: true });
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
