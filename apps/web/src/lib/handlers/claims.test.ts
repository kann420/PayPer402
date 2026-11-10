import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { parseWebConfig } from '../config';
import { body, createWebHarness, type WebHarness } from '../test-support';
import { CLAIM_LIMIT_MESSAGE, createClaimHandler } from './operator';
import { createSessionHandler } from './session';

let w: WebHarness;
let operatorId: string;

async function start(env?: Record<string, string>) {
  w = await createWebHarness(env === undefined ? {} : { env });
  w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'operator' } })));
  operatorId = w.session()?.operator?.id as string;
}
const claim = (name: string, init: { origin?: string | null; cookie?: string | null } = {}) =>
  createClaimHandler(w.deps)(w.request('/api/operator/agents/claims', { body: { name }, ...init }));

describe('configuration', () => {
  const base = { FACILITATOR_URL: 'http://facilitator.test:4020/', SELLER_URL: 'http://seller.test:4021/' };

  it('defaults the public URLs to the internal ones, and the claim limit to 10 an hour', () => {
    const config = parseWebConfig(base);
    expect(config.facilitatorPublicUrl).toBe('http://facilitator.test:4020');
    expect(config.sellerPublicUrl).toBe('http://seller.test:4021');
    expect(config.limits.claimsPerHour).toBe(10);
  });

  it('reads the three variables, and treats blanks as unset', () => {
    const config = parseWebConfig({
      ...base,
      FACILITATOR_PUBLIC_URL: 'https://pay.example.test/',
      SELLER_PUBLIC_URL: 'https://seller.example.test',
      WEB_LIMIT_CLAIMS_PER_HOUR: '3',
    });
    expect(config).toMatchObject({ facilitatorPublicUrl: 'https://pay.example.test', sellerPublicUrl: 'https://seller.example.test' });
    expect(config.limits.claimsPerHour).toBe(3);
    expect(parseWebConfig({ ...base, FACILITATOR_PUBLIC_URL: ' ', SELLER_PUBLIC_URL: '' }).facilitatorPublicUrl).toBe('http://facilitator.test:4020');
  });

  it('rejects a public URL that is not http(s)', () => {
    expect(() => parseWebConfig({ ...base, FACILITATOR_PUBLIC_URL: 'ftp://x' })).toThrow(/FACILITATOR_PUBLIC_URL/);
  });
});

describe('POST /api/operator/agents/claims', () => {
  afterEach(async () => {
    await w.close();
  });

  describe('with public URLs set', () => {
    beforeEach(async () => {
      await start({ FACILITATOR_PUBLIC_URL: 'https://pay.example.test/', SELLER_PUBLIC_URL: 'https://seller.example.test' });
    });

    it('returns the claim and the command built on the server, and stores the seller URL', async () => {
      const res = await claim('research-bot');
      expect(res.status).toBe(201);
      const json = (await body(res)) as { claim: { code: string; name: string; expiresAt: number }; command: string };
      expect(json.claim).toEqual({ code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/), name: 'research-bot', expiresAt: w.h.clock.now + 900 });
      expect(json.command).toBe(`npx -y payper402 onboard --claim ${json.claim.code} --api https://pay.example.test`);
      expect(Object.keys(json).sort()).toEqual(['claim', 'command']);
      expect(w.h.db.prepare('SELECT operator_id, agent_name, seller_url FROM agent_claims').get()).toEqual({
        operator_id: operatorId,
        agent_name: 'research-bot',
        seller_url: 'https://seller.example.test',
      });
    });

    it('does not change the session cookie', async () => {
      const before = w.jar.value;
      const res = await claim('research-bot');
      expect(res.status).toBe(201);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(w.jar.value).toBe(before);
      expect(w.session()?.agents).toEqual([]);
    });
  });

  describe('with the defaults', () => {
    beforeEach(async () => {
      await start();
    });

    it('uses FACILITATOR_URL for --api and SELLER_URL for the stored seller URL', async () => {
      const json = (await body(await claim('research-bot'))) as { command: string };
      expect(json.command).toMatch(/^npx -y payper402 onboard --claim \S+ --api http:\/\/127\.0\.0\.1:\d+$/);
      expect(json.command.endsWith(w.config.facilitatorUrl)).toBe(true);
      expect(w.h.db.prepare('SELECT seller_url FROM agent_claims').get()).toEqual({ seller_url: w.config.sellerUrl });
    });

    it('validates the name with the web rule', async () => {
      const bad = await claim('Bad Name');
      expect(bad.status).toBe(400);
      expect(await body(bad)).toMatchObject({ error: 'validation_failed' });
      expect(w.h.db.prepare('SELECT COUNT(*) AS n FROM agent_claims').get()).toEqual({ n: 0 });
    });

    it('refuses a foreign origin and a missing session', async () => {
      expect((await claim('bot', { origin: 'http://evil.example' })).status).toBe(403);
      const noSession = await claim('bot', { cookie: null });
      expect(noSession.status).toBe(401);
      expect(await body(noSession)).toMatchObject({ error: 'no_session' });
      expect(w.h.db.prepare('SELECT COUNT(*) AS n FROM agent_claims').get()).toEqual({ n: 0 });
    });

    it('passes the facilitator 409 too_many_claims through on the sixth open code', async () => {
      for (let i = 0; i < 5; i++) expect((await claim(`bot-${i}`)).status).toBe(201);
      const sixth = await claim('bot-6');
      expect(sixth.status).toBe(409);
      expect(await body(sixth)).toMatchObject({ error: 'too_many_claims' });
      // The limiter counted the refused request too: the hit comes before the facilitator call.
      expect(w.deps.limits.claimsPerOperator.count(operatorId)).toBe(6);
    });

    it('answers 429 claim_limit on the 11th claim in an hour, before the facilitator is asked', async () => {
      for (let i = 0; i < 10; i++) w.deps.limits.claimsPerOperator.hit(operatorId);
      const res = await claim('research-bot');
      expect(res.status).toBe(429);
      expect(await body(res)).toMatchObject({ error: 'claim_limit', message: CLAIM_LIMIT_MESSAGE });
      expect(CLAIM_LIMIT_MESSAGE).toBe('Too many claim codes right now. Try again later.');
      expect(w.h.db.prepare('SELECT COUNT(*) AS n FROM agent_claims').get()).toEqual({ n: 0 });
    });
  });
});
