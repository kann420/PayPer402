import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from './auth';
import { ConfigError, loadConfig } from './config';
import { SecretBox, hmacHex, randomId } from './crypto';
import { openDatabase } from './db/connection';
import { DatabaseTooNewError, MIGRATIONS, runMigrations, schemaVersion } from './db/migrations';
import { EventBus } from './events';
import { recordAudit, MAX_AUDIT_DETAILS_BYTES } from './audit';
import { silentLogger } from './logger';
import { seed } from './seed';
import { createHarness, TEST_KEY_HEX, TEST_PEPPER, type Harness } from './test-support';

const validEnv = {
  PUBLIC_BASE_URL: 'http://localhost:4020/',
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  DATA_ENCRYPTION_KEY: TEST_KEY_HEX,
  API_KEY_PEPPER: TEST_PEPPER,
};

describe('config', () => {
  it('applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      port: 4020,
      databasePath: './data/facilitator.db',
      publicBaseUrl: 'http://localhost:4020',
      paypalApiBase: 'https://api-m.sandbox.paypal.com',
      settlementTickSeconds: 15,
      walletCheckIntervalSeconds: 30,
      logLevel: 'info',
    });
    expect(config.paypalWebhookId).toBeUndefined();
    expect(config.webAppUrl).toBeUndefined();
    expect(config.dataEncryptionKey).toHaveLength(32);
  });

  it('reads every variable', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '5000',
      DATABASE_PATH: ':memory:',
      WEB_APP_URL: 'https://app.example.test/',
      PAYPAL_WEBHOOK_ID: 'WH-1',
      SETTLEMENT_TICK_SECONDS: '5',
      WALLET_CHECK_INTERVAL_SECONDS: '10',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      port: 5000,
      databasePath: ':memory:',
      webAppUrl: 'https://app.example.test',
      paypalWebhookId: 'WH-1',
      settlementTickSeconds: 5,
      walletCheckIntervalSeconds: 10,
      logLevel: 'debug',
    });
  });

  it.each([
    ['PUBLIC_BASE_URL', { PUBLIC_BASE_URL: undefined }],
    ['PUBLIC_BASE_URL', { PUBLIC_BASE_URL: 'ftp://x' }],
    ['PAYPAL_CLIENT_ID', { PAYPAL_CLIENT_ID: '' }],
    ['PAYPAL_CLIENT_SECRET', { PAYPAL_CLIENT_SECRET: undefined }],
    ['DATA_ENCRYPTION_KEY', { DATA_ENCRYPTION_KEY: 'abc' }],
    ['API_KEY_PEPPER', { API_KEY_PEPPER: 'short' }],
    ['PAYPAL_API_BASE', { PAYPAL_API_BASE: 'https://api-m.paypal.com' }],
    ['SETTLEMENT_TICK_SECONDS', { SETTLEMENT_TICK_SECONDS: '0' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
    ['PORT', { PORT: 'abc' }],
  ])('rejects an invalid %s without echoing values', (name, change) => {
    const env: Record<string, string | undefined> = { ...validEnv, ...change };
    let error: unknown;
    try {
      loadConfig(env);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.join('\n')).toContain(name);
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain(TEST_PEPPER);
  });
});

describe('migrations', () => {
  it('creates the schema from empty, including the pending-settlement index', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db)).toBe(3);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    for (const table of ['operators', 'sellers', 'api_keys', 'wallets', 'agents', 'commitments', 'settlements', 'settlement_items', 'webhook_events', 'audit_log', 'schema_migrations']) {
      expect(tables).toContain(table);
    }
    const index = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'settlements_one_pending'`).get() as { sql: string };
    expect(index.sql).toMatch(/UNIQUE INDEX settlements_one_pending ON settlements\(operator_id\) WHERE status = 'pending'/);

    db.prepare(`INSERT INTO operators VALUES ('op1', 'n', NULL, 1, 1, 1, NULL, 0)`).run();
    const insert = db.prepare(
      `INSERT INTO settlements (id, operator_id, trigger, status, amount, calls_count, paypal_request_id, created_at, updated_at)
       VALUES (?, 'op1', 'manual', ?, 1, 1, ?, 0, 0)`,
    );
    insert.run('s1', 'pending', 's1');
    insert.run('s2', 'completed', 's2');
    expect(() => insert.run('s3', 'pending', 's3')).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(3);
  });

  it('refuses a database newer than the code', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (99, 0)').run();
    expect(schemaVersion(db)).toBe(99);
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(DatabaseTooNewError);
  });

  it('rolls back a failing migration together with its version row', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db, [...MIGRATIONS, { version: 4, sql: 'CREATE TABLE t (x); SELECT * FROM missing;' }])).toThrow();
    expect(schemaVersion(db)).toBe(3);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 't'`).get()).toBeUndefined();
  });

  it('migration 2 upgrades a version-1 database: every wallet row unchanged, vault_id_hash no longer unique', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db, MIGRATIONS.filter((m) => m.version === 1))).toBe(1);
    const insertOperator = db.prepare(`INSERT INTO operators VALUES (?, 'n', NULL, 1, 1, 1, NULL, 0)`);
    for (const id of ['op_linked', 'op_waiting', 'op_none', 'op_other']) insertOperator.run(id);
    const insertWallet = db.prepare(
      `INSERT INTO wallets (operator_id, status, link_state, setup_token_id, link_started_at, link_error, vault_id_sealed,
         vault_id_hash, paypal_customer_id, payer_email_masked, linked_at, stopped_at, last_checked_at, charge_retry_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertWallet.run('op_linked', 'active', null, null, 10, null, 'v1.a.b.c', 'hash-a', 'CUST-1', 'bu***@example.com', 11, null, 12, 13, 14);
    insertWallet.run('op_waiting', 'waiting_for_approval', 'state-w', 'ST-1', 20, null, null, null, null, null, null, null, null, null, 21);
    insertWallet.run('op_none', 'not_linked', null, null, null, 'cancelled', null, null, null, null, null, null, null, null, 31);
    // Version 1 refuses a shared hash.
    expect(() => insertWallet.run('op_other', 'active', null, null, null, null, 'v1.d.e.f', 'hash-a', null, null, null, null, null, null, 1)).toThrow(/UNIQUE/);
    const columns = db.prepare('PRAGMA table_info(wallets)').all();
    const before = db.prepare('SELECT * FROM wallets ORDER BY operator_id').all();

    expect(runMigrations(db)).toBe(3);
    expect(db.prepare('SELECT * FROM wallets ORDER BY operator_id').all()).toEqual(before);
    expect(db.prepare('PRAGMA table_info(wallets)').all()).toEqual(columns);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'wallets_vault_id_hash'`).get()).toBeTruthy();

    // Two wallets can now share a hash; link_state stays unique; the CHECK and the FK still hold.
    insertWallet.run('op_other', 'active', null, null, null, null, 'v1.d.e.f', 'hash-a', null, null, null, null, null, null, 1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM wallets WHERE vault_id_hash = 'hash-a'`).get() as { n: number }).n).toBe(2);
    expect(() => db.prepare(`UPDATE wallets SET link_state = 'state-w' WHERE operator_id = 'op_none'`).run()).toThrow(/UNIQUE/);
    expect(() => db.prepare(`UPDATE wallets SET status = 'bogus' WHERE operator_id = 'op_none'`).run()).toThrow(/CHECK/);
    expect(() => insertWallet.run('op_missing', 'not_linked', null, null, null, null, null, null, null, null, null, null, null, null, 1)).toThrow(/FOREIGN KEY/);

    // A newer database is still refused.
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, 0)').run();
    expect(() => runMigrations(db)).toThrow(DatabaseTooNewError);
  });
});

describe('crypto', () => {
  const box = new SecretBox(Buffer.from(TEST_KEY_HEX, 'hex'));

  it('round-trips a sealed value in the v1 format', () => {
    const sealed = box.seal('PT-123');
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('PT-123');
    expect(box.open(sealed)).toBe('PT-123');
    expect(box.seal('PT-123')).not.toBe(sealed);
  });

  it('detects tampering and a wrong key', () => {
    const sealed = box.seal('PT-123');
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[3] ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => box.open([parts[0], parts[1], parts[2], ct.toString('base64url')].join('.'))).toThrow(/authentication/);
    expect(() => box.open(sealed.replace(/^v1/, 'v2'))).toThrow(/Malformed/);
    expect(() => box.open(`${parts[0]}.${parts[1]}.AAAA.${parts[3]}`)).toThrow(/Malformed/);
    const other = new SecretBox(Buffer.alloc(32, 7));
    expect(() => other.open(sealed)).toThrow(/authentication/);
  });

  it('derives a lookup key that differs from the AES key', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex');
    expect(box.lookupKeyForTest().equals(key)).toBe(false);
    expect(box.lookupHash('PT-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(box.lookupHash('PT-1')).toBe(box.lookupHash('PT-1'));
    expect(box.lookupHash('PT-1')).not.toBe(hmacHex(key, 'PT-1'));
  });

  it('generates prefixed random ids', () => {
    expect(randomId('stl')).toMatch(/^stl_[A-Za-z0-9_-]{22}$/);
  });
});

describe('API keys', () => {
  it('have the documented format and are stored as an HMAC', () => {
    expect(generateApiKey('operator')).toMatch(/^pp402_op_[A-Za-z0-9_-]{43}$/);
    expect(generateApiKey('seller')).toMatch(/^pp402_sel_[A-Za-z0-9_-]{43}$/);
    const key = generateApiKey('seller');
    expect(hashApiKey(TEST_PEPPER, key)).toBe(hmacHex(TEST_PEPPER, key));
  });
});

describe('audit and events', () => {
  it('truncates oversized audit details and never throws', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    recordAudit(db, silentLogger, 1, { actorType: 'system', action: 'x', details: { big: 'a'.repeat(MAX_AUDIT_DETAILS_BYTES * 2) } });
    const row = db.prepare('SELECT details FROM audit_log').get() as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ truncated: true });
    db.close();
    expect(() => recordAudit(db, silentLogger, 1, { actorType: 'system', action: 'y' })).not.toThrow();
  });

  it('catches handler errors and disposes subscribers', async () => {
    const bus = new EventBus(silentLogger);
    const got: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    const dispose = bus.subscribe((event) => {
      got.push(event.type);
    });
    bus.emit({ type: 'wallet.updated', operatorId: 'op', data: { status: 'active' } });
    dispose();
    bus.emit({ type: 'wallet.updated', operatorId: 'op', data: { status: 'active' } });
    expect(got).toEqual(['wallet.updated']);
    expect(bus.listenerCount()).toBe(2);
  });
});

describe('HTTP basics', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers 401 without a key, 401 for an unknown key, 403 for the wrong role, 200 for a good key', async () => {
    const { key: operatorKey } = h.addOperator();
    const { key: sellerKey } = h.addSeller();
    expect((await h.api('GET', '/v1/operator')).status).toBe(401);
    expect((await h.api('GET', '/v1/operator', { key: generateApiKey('operator') })).status).toBe(401);
    expect((await h.api('GET', '/v1/operator', { key: 'not-a-key' })).body).toMatchObject({ error: 'unauthorized' });
    const wrong = await h.api('GET', '/v1/operator', { key: sellerKey });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ error: 'forbidden' });
    expect((await h.api('GET', '/x402/supported', { key: operatorKey })).status).toBe(403);
    expect((await h.api('GET', '/v1/operator', { key: operatorKey })).status).toBe(200);
    expect((await h.api('GET', '/x402/supported', { key: sellerKey })).status).toBe(200);
  });

  it('refuses a revoked key', async () => {
    const { key } = h.addOperator();
    h.db.prepare('UPDATE api_keys SET revoked_at = 1').run();
    expect((await h.api('GET', '/v1/operator', { key })).status).toBe(401);
  });

  it('echoes a valid X-Request-Id and replaces an invalid one', async () => {
    const good = await h.api('GET', '/healthz', { headers: { 'X-Request-Id': 'abc.DEF:1-2_3' } });
    expect(good.headers.get('x-request-id')).toBe('abc.DEF:1-2_3');
    const bad = await h.api('GET', '/healthz', { headers: { 'X-Request-Id': 'has spaces!' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^req_/);
    const none = await h.api('GET', '/healthz');
    expect(none.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('renders errors as { error, message } and validation errors with issues', async () => {
    const { key } = h.addOperator();
    const missing = await h.api('GET', '/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', message: 'Not found' });
    const invalid = await h.api('PUT', '/v1/operator/caps', { key, body: { perCall: 'x' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: 'validation_failed', message: expect.any(String) });
    expect(Array.isArray(invalid.body['issues'])).toBe(true);
    const badJson = await h.api('PUT', '/v1/operator/caps', { key, body: '{not json' });
    expect(badJson.status).toBe(400);
    expect(badJson.body).toMatchObject({ error: 'validation_failed' });
    const tooBig = await h.api('PUT', '/v1/operator/caps', { key, body: { pad: 'x'.repeat(70_000) } });
    expect(tooBig.status).toBe(413);
  });

  it('hides internal errors behind 500 internal_error', async () => {
    const { key } = h.addOperator();
    h.db.exec('DROP TABLE audit_log');
    h.db.exec('DROP TABLE settlement_items');
    const res = await h.api('GET', '/v1/seller/settlements', { key: h.addSeller().key });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Internal error' });
    expect(JSON.stringify(res.body)).not.toContain('settlement_items');
    expect(key).toBeTruthy();
  });

  it('sends no CORS headers on any route', async () => {
    const { key } = h.addOperator();
    const responses = await Promise.all([
      h.api('GET', '/healthz', { headers: { Origin: 'https://evil.test' } }),
      h.api('OPTIONS', '/v1/operator', { headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'GET' } }),
      h.api('GET', '/v1/operator', { key, headers: { Origin: 'https://evil.test' } }),
      h.api('POST', '/webhooks/paypal', { headers: { Origin: 'https://evil.test' }, body: {} }),
      h.api('GET', '/paypal/return?state=x', { headers: { Origin: 'https://evil.test' } }),
    ]);
    for (const res of responses) {
      for (const name of res.headers.keys()) expect(name.startsWith('access-control-')).toBe(false);
    }
  });

  it('reports health', async () => {
    expect((await h.api('GET', '/healthz')).body).toEqual({ ok: true });
  });
});

describe('seed', () => {
  it('is idempotent, and --reset reissues keys', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const first = seed(db, { now: 1, pepper: TEST_PEPPER });
    expect(first.created).toEqual({ operator: true, seller: true });
    expect(first.operatorKey).toMatch(/^pp402_op_/);
    expect(first.sellerKey).toMatch(/^pp402_sel_/);
    expect(first.agentPrivateKeyJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    const operator = db.prepare('SELECT * FROM operators').get() as Record<string, unknown>;
    expect(operator).toMatchObject({ name: 'Northwind Research', cap_per_call: 10, cap_daily: 1000, cap_unsettled: 500, cap_total: 5000 });
    expect(db.prepare('SELECT status FROM wallets').get()).toEqual({ status: 'not_linked' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE status = 'active'`).get() as { n: number }).n).toBe(1);
    const stored = (db.prepare('SELECT key_hash FROM api_keys').all() as { key_hash: string }[]).map((r) => r.key_hash);
    expect(stored).toContain(hashApiKey(TEST_PEPPER, first.operatorKey ?? ''));
    expect(JSON.stringify(db.prepare('SELECT * FROM api_keys').all())).not.toContain(first.operatorKey);
    expect(JSON.stringify(db.prepare('SELECT * FROM agents').all())).not.toContain(first.agentPrivateKeyJwk?.d);

    const second = seed(db, { now: 2, pepper: TEST_PEPPER });
    expect(second.created).toEqual({ operator: false, seller: false });
    expect(second.operatorKey).toBeUndefined();
    expect(second.operatorId).toBe(first.operatorId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM operators').get() as { n: number }).n).toBe(1);

    const reset = seed(db, { now: 3, pepper: TEST_PEPPER, reset: true });
    expect(reset.created).toEqual({ operator: true, seller: true });
    expect(reset.operatorId).not.toBe(first.operatorId);
    expect(reset.operatorKey).not.toBe(first.operatorKey);
    expect((db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM operators').get() as { n: number }).n).toBe(1);
  });
});
