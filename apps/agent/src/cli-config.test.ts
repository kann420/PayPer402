import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPrivateKeyRaw, generateAgentKey, publicKeyX } from '@payper402/scheme-paypal';
import { configDir, configPath, readCliConfig, writeCliConfig, type CliConfig } from './cli-config';

describe('payper402 config file', () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'payper402-config-'));
    env = { PAYPER402_HOME: path.join(dir, 'home') };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (key = generateAgentKey()): CliConfig => ({
    version: 1,
    facilitatorUrl: 'http://localhost:4020',
    sellerUrl: 'http://localhost:4021',
    operatorName: 'Northwind Research (demo)',
    agent: { id: 'agt_test', name: 'research-bot', kid: key.kid, keyFingerprint: `ed25519:${key.kid.slice(0, 6)}${key.kid.slice(-4)}` },
    privateKey: exportPrivateKeyRaw(key.privateKey),
    createdAt: 1_793_000_000,
  });
  const writeRaw = async (value: unknown) => {
    await mkdir(env['PAYPER402_HOME'] as string, { recursive: true });
    await writeFile(configPath(env), typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('resolves the directory from PAYPER402_HOME, else ~/.payper402', () => {
    expect(configDir(env)).toBe(path.resolve(env['PAYPER402_HOME'] as string));
    expect(configPath(env)).toBe(path.join(path.resolve(env['PAYPER402_HOME'] as string), 'config.json'));
    expect(configDir({})).toBe(path.join(homedir(), '.payper402'));
    expect(configDir({ PAYPER402_HOME: '  ' })).toBe(path.join(homedir(), '.payper402'));
  });

  it('round-trips a config and returns the private key', async () => {
    const key = generateAgentKey();
    const config = sample(key);
    await writeCliConfig(env, config);
    const read = await readCliConfig(env);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.config).toEqual(config);
    expect(publicKeyX(read.privateKey)).toBe(key.publicKeyX);
  });

  it('reports a missing file', async () => {
    expect(await readCliConfig(env)).toEqual({ ok: false, reason: 'missing' });
  });

  it('leaves no temporary file behind, and replaces an existing config', async () => {
    await writeCliConfig(env, sample());
    const replacement = sample();
    await writeCliConfig(env, replacement);
    expect(await readdir(env['PAYPER402_HOME'] as string)).toEqual(['config.json']);
    expect(JSON.parse(await readFile(configPath(env), 'utf8'))).toEqual(replacement);
  });

  it.skipIf(process.platform === 'win32')('creates the directory with mode 0700 and the file with mode 0600', async () => {
    await writeCliConfig(env, sample());
    expect((await stat(env['PAYPER402_HOME'] as string)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['invalid JSON', () => '{ not json'],
    ['an extra field', () => ({ ...sample(), extra: true })],
    ['a missing field', () => ({ ...sample(), sellerUrl: undefined })],
    ['a wrong version', () => ({ ...sample(), version: 2 })],
    ['a non-http URL', () => ({ ...sample(), sellerUrl: 'ftp://seller.test' })],
    ['an extra field in agent', () => ({ ...sample(), agent: { ...sample().agent, extra: 1 } })],
    ['a private key that is not a seed', () => ({ ...sample(), privateKey: 'not-a-seed' })],
    ['a private key that does not match the kid', () => ({ ...sample(), privateKey: exportPrivateKeyRaw(generateAgentKey().privateKey) })],
    ['a JSON array', () => []],
  ])('treats %s as invalid, and reports nothing from the file', async (_name, make) => {
    await writeRaw(make());
    const read = await readCliConfig(env);
    expect(read).toEqual({ ok: false, reason: 'invalid' });
  });

  it('treats an unreadable path as invalid, not missing', async () => {
    // A directory where the file should be.
    await mkdir(configPath(env), { recursive: true });
    expect(await readCliConfig(env)).toEqual({ ok: false, reason: 'invalid' });
  });
});
