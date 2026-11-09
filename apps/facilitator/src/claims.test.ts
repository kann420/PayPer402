import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET,
  BINDING_VERSION,
  PAYPAL_SANDBOX_NETWORK,
  SCHEME,
  buildCommitment,
  generateAgentKey,
  signCommitment,
  type AgentKey,
} from '@payper402/scheme-paypal';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { CLAIM_TTL_SECONDS, MAX_OPEN_CLAIMS, claimCodeHash, generateClaimCode, normaliseClaimCode } from './claims';
import { ConfigError, loadConfig } from './config';
import { openDatabase } from './db/connection';
import { MIGRATIONS, runMigrations, schemaVersion } from './db/migrations';
import { seed } from './seed';
import { createHarness, T0, TEST_PEPPER, type Harness } from './test-support';

describe('claim codes', () => {
  it('are three groups of four Crockford characters, and normalise to themselves', () => {
    for (let i = 0; i < 50; i++) {
      const { display, normalised } = generateClaimCode();
      expect(display).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(normaliseClaimCode(display)).toBe(normalised);
      expect(display.replaceAll('-', '')).toBe(normalised);
    }
  });

  it('are distinct across 1,000 draws', () => {
    expect(new Set(Array.from({ length: 1000 }, () => generateClaimCode().normalised)).size).toBe(1000);
  });

  it('normalise lower case, spaces, missing dashes and Crockford look-alikes', () => {
    expect(normaliseClaimCode('k7qm-2xrd-9vht')).toBe('K7QM2XRD9VHT');
    expect(normaliseClaimCode(' K7QM 2XRD 9VHT ')).toBe('K7QM2XRD9VHT');
    expect(normaliseClaimCode('K7QM2XRD9VHT')).toBe('K7QM2XRD9VHT');
    expect(normaliseClaimCode('OOOO-IIII-LLLL')).toBe('000011111111');
    expect(normaliseClaimCode('oOiI-lL00-1111')).toBe('001111001111');
  });

  it.each([
    ['too short', 'K7QM-2XRD-9VH'],
    ['too long', 'K7QM-2XRD-9VHT-A'],
    ['has a U', 'K7QM-2XRD-9VHU'],
    ['has punctuation', 'K7QM-2XRD-9V.T'],
    ['is empty', ''],
  ])('reject a code that %s', (_name, input) => {
    expect(normaliseClaimCode(input)).toBeUndefined();
  });

  it('hash under the pepper with a claim prefix', () => {
    const hash = claimCodeHash(TEST_PEPPER, 'K7QM2XRD9VHT');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(claimCodeHash(TEST_PEPPER, 'K7QM2XRD9VHT')).toBe(hash);
    expect(claimCodeHash('another-pepper-another-pepper-another', 'K7QM2XRD9VHT')).not.toBe(hash);
  });
});

describe('FACILITATOR_TRUST_PROXY', () => {
  const env = {
    PUBLIC_BASE_URL: 'http://localhost:4020',
    PAYPAL_CLIENT_ID: 'cid',
    PAYPAL_CLIENT_SECRET: 'secret',
    DATA_ENCRYPTION_KEY: '0f'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
  };

  it('defaults to off, and accepts 0 and 1 only', () => {
    expect(loadConfig(env).trustProxy).toBe(false);
    expect(loadConfig({ ...env, FACILITATOR_TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(loadConfig({ ...env, FACILITATOR_TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ...env, FACILITATOR_TRUST_PROXY: ' ' }).trustProxy).toBe(false);
    expect(() => loadConfig({ ...env, FACILITATOR_TRUST_PROXY: 'yes' })).toThrow(ConfigError);
  });
});

describe('migration 3', () => {
  it('a fresh database reaches version 3 with the claims table and its index', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db)).toBe(3);
    const columns = (db.prepare('PRAGMA table_info(agent_claims)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(['id', 'operator_id', 'code_hash', 'agent_name', 'seller_url', 'created_at', 'expires_at', 'redeemed_at', 'agent_id']);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'agent_claims_operator'`).get()).toBeTruthy();
    db.prepare(`INSERT INTO operators VALUES ('op1', 'n', NULL, 1, 1, 1, NULL, 0)`).run();
    const insert = db.prepare(
      `INSERT INTO agent_claims (id, operator_id, code_hash, agent_name, created_at, expires_at) VALUES (?, ?, ?, 'a', 0, 1)`,
    );
    insert.run('clm_1', 'op1', 'hash');
    expect(() => insert.run('clm_2', 'op1', 'hash')).toThrow(/UNIQUE/);
    expect(() => insert.run('clm_3', 'missing', 'hash-3')).toThrow(/FOREIGN KEY/);
  });

  it('a version 2 database with rows upgrades on start-up and keeps them', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db, MIGRATIONS.filter((m) => m.version <= 2))).toBe(2);
    db.prepare(`INSERT INTO operators VALUES ('op1', 'n', NULL, 1, 1, 1, NULL, 0)`).run();
    db.prepare(`INSERT INTO wallets (operator_id, status, updated_at) VALUES ('op1', 'not_linked', 0)`).run();
    db.prepare(`INSERT INTO agents (id, operator_id, name, kid, public_key_x, status, created_at) VALUES ('agt1', 'op1', 'a', 'kid1', 'x', 'active', 0)`).run();
    const before = {
      operators: db.prepare('SELECT * FROM operators').all(),
      wallets: db.prepare('SELECT * FROM wallets').all(),
      agents: db.prepare('SELECT * FROM agents').all(),
    };
    expect(runMigrations(db)).toBe(3);
    expect(schemaVersion(db)).toBe(3);
    expect(db.prepare('SELECT * FROM operators').all()).toEqual(before.operators);
    expect(db.prepare('SELECT * FROM wallets').all()).toEqual(before.wallets);
    expect(db.prepare('SELECT * FROM agents').all()).toEqual(before.agents);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_claims').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('claims', () => {
  let h: Harness;
  let operatorId: string;
  let operatorKey: string;
  let sellerKey: string;

  beforeEach(() => {
    h = createHarness();
    ({ operatorId, key: operatorKey } = h.addOperator());
    sellerKey = h.addSeller().key;
  });
  afterEach(async () => {
    await h.close();
  });

  type Claim = { id: string; code: string; name: string; expiresAt: number };
  const issue = (body: unknown = { name: 'research-bot' }, key = operatorKey) => h.api('POST', '/v1/agents/claims', { key, body });
  const issued = async (body?: unknown): Promise<Claim> => {
    const res = await issue(body);
    expect(res.status).toBe(201);
    return (res.body['claim'] as Claim);
  };
  const redeem = (body: unknown, headers?: Record<string, string>) =>
    h.api('POST', '/v1/claims/redeem', { body, ...(headers === undefined ? {} : { headers }) });
  const lines = (table: string) => JSON.stringify(h.db.prepare(`SELECT * FROM ${table}`).all());

  describe('POST /v1/agents/claims', () => {
    it('issues a code that expires in 15 minutes and stores only its hash', async () => {
      const claim = await issued();
      expect(claim).toMatchObject({ name: 'research-bot', expiresAt: T0 + CLAIM_TTL_SECONDS });
      expect(claim.id).toMatch(/^clm_[A-Za-z0-9_-]{22}$/);
      expect(claim.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

      const normalised = normaliseClaimCode(claim.code) as string;
      const row = h.db.prepare('SELECT * FROM agent_claims WHERE id = ?').get(claim.id) as Record<string, unknown>;
      expect(row).toMatchObject({
        operator_id: operatorId,
        code_hash: claimCodeHash(TEST_PEPPER, normalised),
        agent_name: 'research-bot',
        seller_url: null,
        created_at: T0,
        expires_at: T0 + 900,
        redeemed_at: null,
        agent_id: null,
      });
      // The code, in either form, appears in no text column of the claim table or the audit log.
      for (const table of ['agent_claims', 'audit_log']) {
        expect(lines(table)).not.toContain(claim.code);
        expect(lines(table)).not.toContain(normalised);
      }
      const audit = h.db.prepare(`SELECT * FROM audit_log WHERE action = 'agent.claim_issued'`).get() as Record<string, unknown>;
      expect(audit).toMatchObject({ actor_type: 'operator', actor_id: operatorId, resource_type: 'agent_claim', resource_id: claim.id });
      expect(JSON.parse(audit['details'] as string)).toEqual({ name: 'research-bot' });
      expect(h.seen).toEqual([]);
    });

    it('stores the seller URL without trailing slashes', async () => {
      const claim = await issued({ name: 'bot', sellerUrl: 'https://seller.example.test:4021//' });
      const row = h.db.prepare('SELECT seller_url FROM agent_claims WHERE id = ?').get(claim.id);
      expect(row).toEqual({ seller_url: 'https://seller.example.test:4021' });
    });

    it('refuses a seller key, a missing key and unknown fields', async () => {
      expect((await issue({ name: 'bot' }, sellerKey)).status).toBe(403);
      expect((await h.api('POST', '/v1/agents/claims', { body: { name: 'bot' } })).status).toBe(401);
      expect((await issue({ name: 'bot', extra: 1 })).status).toBe(400);
      expect((await issue({ name: '  ' })).status).toBe(400);
      expect((await issue({})).status).toBe(400);
    });

    it.each([
      ['an ftp URL', 'ftp://seller.test'],
      ['a relative URL', '/seller'],
      ['a long URL', `https://seller.test/${'a'.repeat(300)}`],
    ])('rejects %s as sellerUrl', async (_name, sellerUrl) => {
      const res = await issue({ name: 'bot', sellerUrl });
      expect(res.status).toBe(400);
      expect(res.body['error']).toBe('validation_failed');
    });

    it('allows five open claims, answers 409 for the sixth, and counts expired and redeemed ones out', async () => {
      for (let i = 0; i < MAX_OPEN_CLAIMS; i++) await issued({ name: `bot-${i}` });
      const sixth = await issue({ name: 'bot-6' });
      expect(sixth.status).toBe(409);
      expect(sixth.body['error']).toBe('too_many_claims');
      // Another operator is not affected.
      expect((await issue({ name: 'bot' }, h.addOperator().key)).status).toBe(201);
      // Expired claims stop counting the moment they expire.
      h.clock.now = T0 + CLAIM_TTL_SECONDS;
      expect((await issue({ name: 'bot-7' })).status).toBe(201);
    });

    it('does not count a redeemed claim as open', async () => {
      const first = await issued({ name: 'bot-0' });
      for (let i = 1; i < MAX_OPEN_CLAIMS; i++) await issued({ name: `bot-${i}` });
      expect((await issue({ name: 'bot-x' })).status).toBe(409);
      expect((await redeem({ code: first.code, publicKeyX: generateAgentKey().publicKeyX })).status).toBe(201);
      expect((await issue({ name: 'bot-x' })).status).toBe(201);
    });
  });

  describe('POST /v1/claims/redeem', () => {
    it('creates an active agent under the claim operator with the caller public key', async () => {
      const claim = await issued({ name: 'research-bot', sellerUrl: 'http://localhost:4021' });
      const key = generateAgentKey();
      const res = await redeem({ code: claim.code, publicKeyX: key.publicKeyX });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        agent: {
          id: expect.stringMatching(/^agt_/),
          name: 'research-bot',
          kid: key.kid,
          keyFingerprint: `ed25519:${key.kid.slice(0, 6)}${key.kid.slice(-4)}`,
          status: 'active',
          createdAt: T0,
        },
        operator: { name: 'Test operator' },
        sellerUrl: 'http://localhost:4021',
      });
      const agentId = (res.body['agent'] as { id: string }).id;
      expect(h.db.prepare('SELECT operator_id, public_key_x, status FROM agents WHERE id = ?').get(agentId)).toEqual({
        operator_id: operatorId,
        public_key_x: key.publicKeyX,
        status: 'active',
      });
      expect(h.db.prepare('SELECT redeemed_at, agent_id FROM agent_claims WHERE id = ?').get(claim.id)).toEqual({ redeemed_at: T0, agent_id: agentId });
      expect(h.seen.filter((e) => e.type === 'agent.updated')).toEqual([
        { type: 'agent.updated', operatorId, data: { id: agentId, status: 'active' } },
      ]);

      const created = h.db.prepare(`SELECT * FROM audit_log WHERE action = 'agent.created'`).get() as Record<string, unknown>;
      expect(created).toMatchObject({ actor_type: 'operator', actor_id: operatorId, resource_id: agentId });
      expect(JSON.parse(created['details'] as string)).toEqual({ generatedKey: false, via: 'claim', claimId: claim.id });
      const redeemed = h.db.prepare(`SELECT * FROM audit_log WHERE action = 'agent.claim_redeemed'`).get() as Record<string, unknown>;
      expect(redeemed).toMatchObject({ actor_type: 'system', actor_id: 'claim', resource_type: 'agent_claim', resource_id: claim.id });
      expect(JSON.parse(redeemed['details'] as string)).toEqual({ agentId });
      // The code appears nowhere after redemption either.
      expect(lines('audit_log')).not.toContain(claim.code);
    });

    it('returns a null sellerUrl when none was stored', async () => {
      const claim = await issued();
      const res = await redeem({ code: claim.code, publicKeyX: generateAgentKey().publicKeyX });
      expect(res.status).toBe(201);
      expect(res.body['sellerUrl']).toBeNull();
    });

    it('accepts lower case and a code without dashes', async () => {
      const first = await issued({ name: 'one' });
      const second = await issued({ name: 'two' });
      const a = await redeem({ code: first.code.toLowerCase(), publicKeyX: generateAgentKey().publicKeyX });
      const b = await redeem({ code: second.code.replaceAll('-', ' '), publicKeyX: generateAgentKey().publicKeyX });
      expect(a.status).toBe(201);
      expect((a.body['agent'] as { name: string }).name).toBe('one');
      expect(b.status).toBe(201);
      expect((b.body['agent'] as { name: string }).name).toBe('two');
    });

    it('answers 404 for an unknown code, and 400 for a malformed code without a database lookup', async () => {
      const key = generateAgentKey();
      const unknown = await redeem({ code: generateClaimCode().display, publicKeyX: key.publicKeyX });
      expect(unknown.status).toBe(404);
      expect(unknown.body['error']).toBe('claim_not_found');

      const prepare = vi.spyOn(h.db, 'prepare');
      const malformed = await redeem({ code: 'not a code', publicKeyX: key.publicKeyX });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ error: 'validation_failed', issues: [{ path: 'code' }] });
      expect(prepare.mock.calls.filter(([sql]) => String(sql).includes('agent_claims'))).toEqual([]);
      prepare.mockRestore();
    });

    it('answers 400 for a malformed publicKeyX, with the same issue text as POST /v1/agents', async () => {
      const claim = await issued();
      const res = await redeem({ code: claim.code, publicKeyX: 'AAAA' });
      expect(res.status).toBe(400);
      expect(res.body['issues']).toEqual([{ path: 'publicKeyX', message: 'publicKeyX must be a raw Ed25519 public key (32 bytes, base64url)' }]);
      const viaAgents = await h.api('POST', '/v1/agents', { key: operatorKey, body: { name: 'x', publicKeyX: 'AAAA' } });
      expect(viaAgents.body['issues']).toEqual(res.body['issues']);
      // The claim is untouched and still redeemable.
      expect((await redeem({ code: claim.code, publicKeyX: generateAgentKey().publicKeyX })).status).toBe(201);
    });

    it('rejects unknown fields and over-long values', async () => {
      const claim = await issued();
      const key = generateAgentKey();
      expect((await redeem({ code: claim.code, publicKeyX: key.publicKeyX, extra: true })).status).toBe(400);
      expect((await redeem({ code: 'A'.repeat(41), publicKeyX: key.publicKeyX })).status).toBe(400);
      expect((await redeem({ code: claim.code, publicKeyX: 'A'.repeat(101) })).status).toBe(400);
      expect((await redeem(undefined)).status).toBe(400);
    });

    it('answers 409 claim_used for a second redemption, and creates no second agent', async () => {
      const claim = await issued();
      expect((await redeem({ code: claim.code, publicKeyX: generateAgentKey().publicKeyX })).status).toBe(201);
      const again = await redeem({ code: claim.code, publicKeyX: generateAgentKey().publicKeyX });
      expect(again.status).toBe(409);
      expect(again.body['error']).toBe('claim_used');
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
    });

    it('answers 410 claim_expired from the expiry second on, and redeems up to the second before', async () => {
      const early = await issued({ name: 'early' });
      const late = await issued({ name: 'late' });
      h.clock.now = T0 + CLAIM_TTL_SECONDS - 1;
      expect((await redeem({ code: early.code, publicKeyX: generateAgentKey().publicKeyX })).status).toBe(201);
      h.clock.now = T0 + CLAIM_TTL_SECONDS;
      const expired = await redeem({ code: late.code, publicKeyX: generateAgentKey().publicKeyX });
      expect(expired.status).toBe(410);
      expect(expired.body['error']).toBe('claim_expired');
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
    });

    it('answers 409 agent_key_exists and leaves the claim open', async () => {
      const existing = h.addAgent(operatorId).key;
      const claim = await issued();
      const res = await redeem({ code: claim.code, publicKeyX: existing.publicKeyX });
      expect(res.status).toBe(409);
      expect(res.body['error']).toBe('agent_key_exists');
      expect(h.db.prepare('SELECT redeemed_at, agent_id FROM agent_claims WHERE id = ?').get(claim.id)).toEqual({ redeemed_at: null, agent_id: null });
      expect(h.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('agent.created', 'agent.claim_redeemed')`).get()).toEqual({ n: 0 });
      expect((await redeem({ code: claim.code, publicKeyX: generateAgentKey().publicKeyX })).status).toBe(201);
    });

    it('creates an agent that can pay: its commitment verifies', async () => {
      h.activateWallet(operatorId);
      const claim = await issued();
      const key = generateAgentKey();
      expect((await redeem({ code: claim.code, publicKeyX: key.publicKeyX })).status).toBe(201);
      const seller = h.addSeller();
      const requirements: PaymentRequirements = {
        scheme: SCHEME,
        network: PAYPAL_SANDBOX_NETWORK,
        asset: ASSET,
        amount: '5',
        payTo: seller.sellerId,
        maxTimeoutSeconds: 300,
        extra: { version: BINDING_VERSION },
      };
      const verify = await h.api('POST', '/x402/verify', {
        key: seller.key,
        body: { x402Version: 2, paymentPayload: payment(key, requirements, h.clock.now), paymentRequirements: requirements },
      });
      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({ isValid: true });
    });
  });

  describe('rate limits', () => {
    const unknownCode = () => redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX });

    it('answers 429 with Retry-After on the 11th redemption in a minute, and recovers when time moves', async () => {
      for (let i = 0; i < 10; i++) expect((await unknownCode()).status).toBe(404);
      const limited = await unknownCode();
      expect(limited.status).toBe(429);
      expect(limited.body['error']).toBe('too_many_requests');
      expect(limited.headers.get('retry-after')).toBe('60');
      h.clock.now = T0 + 30;
      expect((await unknownCode()).headers.get('retry-after')).toBe('30');
      h.clock.now = T0 + 61;
      expect((await unknownCode()).status).toBe(404);
    });

    it('does not record a hit while a window is full', async () => {
      for (let i = 0; i < 10; i++) await unknownCode();
      for (let i = 0; i < 5; i++) expect((await unknownCode()).status).toBe(429);
      // The refused requests did not extend the window: it clears 60 s after the first ten.
      h.clock.now = T0 + 60;
      expect((await unknownCode()).status).toBe(404);
    });

    it('shares one bucket without a trusted proxy, whatever X-Forwarded-For says', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX }, { 'X-Forwarded-For': `10.0.0.${i}` })).status).toBe(404);
      }
      const res = await redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX }, { 'X-Forwarded-For': '10.0.1.1' });
      expect(res.status).toBe(429);
    });

    it('keys on the first X-Forwarded-For address with FACILITATOR_TRUST_PROXY', async () => {
      await h.close();
      h = createHarness({ config: { trustProxy: true } });
      const from = (address: string) =>
        redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX }, { 'X-Forwarded-For': `${address}, 192.0.2.1` });
      for (let i = 0; i < 10; i++) expect((await from('203.0.113.1')).status).toBe(404);
      expect((await from('203.0.113.1')).status).toBe(429);
      expect((await from('203.0.113.2')).status).toBe(404);
    });

    it('limits all clients to 300 redemptions an hour', async () => {
      await h.close();
      h = createHarness({ config: { trustProxy: true } });
      for (let i = 0; i < 300; i++) {
        h.clock.now = T0 + Math.floor(i / 10) * 61;
        const res = await redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX }, { 'X-Forwarded-For': '203.0.113.7' });
        expect(res.status).toBe(404);
      }
      // 30 batches of 61 s is 1,769 s: still inside the hour.
      const over = await redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX }, { 'X-Forwarded-For': '203.0.113.8' });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(60);
      h.clock.now = T0 + 3601;
      expect((await redeem({ code: generateClaimCode().display, publicKeyX: generateAgentKey().publicKeyX }, { 'X-Forwarded-For': '203.0.113.8' })).status).toBe(404);
    });
  });

  describe('seed reset', () => {
    it('deletes the operator claims (open and redeemed) before its agents', async () => {
      const result = seed(h.db, { now: T0, pepper: TEST_PEPPER });
      const demoOperatorKey = result.operatorKey as string;
      const open = await h.api('POST', '/v1/agents/claims', { key: demoOperatorKey, body: { name: 'open' } });
      const used = await h.api('POST', '/v1/agents/claims', { key: demoOperatorKey, body: { name: 'used' } });
      expect(open.status).toBe(201);
      const redeemed = await redeem({ code: (used.body['claim'] as Claim).code, publicKeyX: generateAgentKey().publicKeyX });
      expect(redeemed.status).toBe(201);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM agent_claims WHERE operator_id = ?').get(result.operatorId)).toEqual({ n: 2 });

      const again = seed(h.db, { now: T0, pepper: TEST_PEPPER, reset: true });
      expect(again.created.operator).toBe(true);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM agent_claims WHERE operator_id = ?').get(result.operatorId)).toEqual({ n: 0 });
      expect(h.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });
});

function payment(key: AgentKey, req: PaymentRequirements, iat: number): PaymentPayload {
  const commitment = buildCommitment({
    kid: key.kid,
    network: req.network,
    asset: req.asset,
    payTo: req.payTo,
    maxAmount: req.amount,
    iat,
    exp: iat + 120,
  });
  return {
    x402Version: 2,
    resource: { url: 'https://seller.test/api/quote?q=1' },
    accepted: req,
    payload: { commitment, signature: signCommitment(commitment, key.privateKey) },
  };
}
