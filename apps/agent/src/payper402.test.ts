import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSeller, type RunningSeller } from '@payper402/demo-seller';
import { createHarness, T0, type Harness } from '@payper402/facilitator/test-support';
import { exportPrivateKeyRaw, generateAgentKey, publicKeyX } from '@payper402/scheme-paypal';
import { configPath, readCliConfig, writeCliConfig, type CliConfig } from './cli-config';
import { loadAgentConfig } from './config';
import { startMcpStdio } from './mcp';
import { runPayper402 } from './payper402';
import { openSession } from './session';
import { FakeSellerAi, fakeAnthropic, message, startDemoEnv, toolUse, type Env } from './test-support';

describe('payper402', () => {
  let h: Harness;
  let home: string;
  let env: Record<string, string | undefined>;
  let operatorId: string;
  let operatorKey: string;
  let out: string[];
  let err: string[];
  let io: { out(line: string): void; err(line: string): void };
  let requests: { url: string; method: string; body: string | undefined; authorization: string | null }[];
  let spy: typeof fetch;

  beforeEach(async () => {
    h = createHarness();
    ({ operatorId, key: operatorKey } = h.addOperator({ caps: { perCall: 10, daily: 1000, unsettled: 500 } }));
    h.activateWallet(operatorId);
    home = await mkdtemp(path.join(tmpdir(), 'payper402-cli-'));
    env = { PAYPER402_HOME: path.join(home, 'home') };
    out = [];
    err = [];
    io = { out: (line) => out.push(line), err: (line) => err.push(line) };
    requests = [];
    spy = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return fetch(input, init);
    }) as typeof fetch;
  });
  afterEach(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });

  type Claim = { code: string };
  const issue = async (name = 'research-bot', sellerUrl: string | undefined = 'http://localhost:4021') => {
    const res = await h.api('POST', '/v1/agents/claims', { key: operatorKey, body: { name, ...(sellerUrl === undefined ? {} : { sellerUrl }) } });
    expect(res.status).toBe(201);
    return (res.body['claim'] as Claim).code;
  };
  const deps = (more: Record<string, unknown> = {}) => ({ fetch: spy, now: () => h.clock.now, platform: 'linux' as const, ...more });
  const run = (argv: string[], more: Record<string, unknown> = {}, e = env) => runPayper402(argv, e, io, deps(more));
  const onboard = async (extra: string[] = [], code?: string) =>
    run(['onboard', '--claim', code ?? (await issue()), '--api', await h.url(), ...extra]);
  const readConfig = async () => {
    const read = await readCliConfig(env);
    if (!read.ok) throw new Error('expected a config');
    return read;
  };

  describe('help and version', () => {
    it.each([[[]], [['help']], [['--help']], [['-h']]])('%j prints the usage with the config path and exits 0', async (argv) => {
      expect(await run(argv)).toBe(0);
      expect(err).toEqual([]);
      expect(out[0]).toBe('payper402 - pay-per-call for AI agents, settled with PayPal');
      expect(out).toContain('  payper402 onboard --claim <code> [--api <url>] [--seller <url>] [--force]');
      expect(out.at(-1)).toBe(`Config: ${configPath(env)}`);
      for (const line of out) expect(line).toMatch(/^[\x20-\x7e]*$/);
    });

    it.each([['version'], ['--version'], ['-v']])('%s prints the package version', async (command) => {
      const pkg = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
      expect(await run([command])).toBe(0);
      expect(out).toEqual([pkg.version]);
    });

    it('prints an unknown command, then the usage, to stderr and exits 1', async () => {
      expect(await run(['frobnicate'])).toBe(1);
      expect(out).toEqual([]);
      expect(err[0]).toBe("Error: Unknown command 'frobnicate'");
      expect(err[1]).toBe('payper402 - pay-per-call for AI agents, settled with PayPal');
      expect(err.at(-1)).toBe(`Config: ${configPath(env)}`);
    });

    it.each([
      [['status', '--nope'], "Unknown option '--nope'"],
      [['status', 'extra'], 'Unexpected argument'],
      [['onboard', '--claim', 'x', '--bogus'], "Unknown option '--bogus'"],
      [['mcp', '--no-spend-check'], "Unknown option '--no-spend-check'"],
      [['mcp', 'task words'], 'Unexpected argument'],
      [['run', '--nope', 'task'], "Unknown option '--nope'"],
      [['onboard'], '--claim <code> is required'],
    ])('%j is a usage error', async (argv, part) => {
      expect(await run(argv)).toBe(1);
      expect(out).toEqual([]);
      expect(err[0]).toContain(part);
      expect(err[0]).toMatch(/^Error: /);
      expect(err.length).toBeGreaterThan(5);
    });
  });

  describe('onboard', () => {
    it('registers the public key, writes the config and prints the next steps', async () => {
      const code = await issue('research-bot', 'http://localhost:4021');
      expect(await run(['onboard', '--claim', code, '--api', await h.url()])).toBe(0);
      expect(err).toEqual([]);
      const { config, privateKey } = await readConfig();
      expect(out).toEqual([
        `Connected as research-bot (${config.agent.keyFingerprint}) for Test operator.`,
        `Your private key stays on this machine: ${configPath(env)}`,
        '',
        'Next:',
        '  payper402 status',
        '  claude mcp add -s user payper402 -- payper402 mcp',
      ]);
      expect(config).toMatchObject({
        version: 1,
        facilitatorUrl: await h.url(),
        sellerUrl: 'http://localhost:4021',
        operatorName: 'Test operator',
        createdAt: T0,
        agent: { name: 'research-bot' },
      });
      // The facilitator holds the public key of the config key, and the agent is the operator's.
      const row = h.db.prepare('SELECT * FROM agents WHERE id = ?').get(config.agent.id) as Record<string, unknown>;
      expect(row).toMatchObject({ operator_id: operatorId, name: 'research-bot', kid: config.agent.kid, public_key_x: publicKeyX(privateKey), status: 'active' });
      // The seed reaches neither the output, the request, nor the database.
      const seed = config.privateKey;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`${await h.url()}/v1/claims/redeem`);
      expect(Object.keys(JSON.parse(requests[0]?.body ?? '{}') as object).sort()).toEqual(['code', 'publicKeyX']);
      expect(JSON.stringify(requests)).not.toContain(seed);
      expect([...out, ...err].join('\n')).not.toContain(seed);
      expect(JSON.stringify(h.db.prepare('SELECT * FROM agents').all())).not.toContain(seed);
      expect(JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all())).not.toContain(seed);
    });

    it('prints the Windows line on win32', async () => {
      expect(await run(['onboard', '--claim', await issue(), '--api', await h.url()], { platform: 'win32' })).toBe(0);
      expect(out.at(-1)).toBe('  claude mcp add -s user payper402 -- cmd /c payper402 mcp');
    });

    it('lets --seller override the stored seller URL, and uses the default when neither is set', async () => {
      expect(await onboard(['--seller', 'http://seller.example.test:9//'], await issue('one', 'http://stored.test'))).toBe(0);
      expect((await readConfig()).config.sellerUrl).toBe('http://seller.example.test:9');
      expect(await onboard(['--force'], await issue('two', 'http://stored.test'))).toBe(0);
      expect((await readConfig()).config.sellerUrl).toBe('http://stored.test');
      expect(await onboard(['--force'], await issue('three', undefined))).toBe(0);
      expect((await readConfig()).config.sellerUrl).toBe('http://localhost:4021');
    });

    const configFiles = async () => (await readdir(path.dirname(configPath(env)))).sort();

    it('switches an already connected machine to the new agent, keeping the old config aside', async () => {
      expect(await onboard()).toBe(0);
      const first = await readConfig();
      const firstText = await readFile(configPath(env), 'utf8');
      out.length = 0;

      expect(await onboard([], await issue('second-bot'))).toBe(0);
      const second = await readConfig();
      expect(second.config.agent.name).toBe('second-bot');
      expect(second.config.agent.kid).not.toBe(first.config.agent.kid);

      const backup = path.join(path.dirname(configPath(env)), `config.research-bot-${h.clock.now}.json`);
      expect(await configFiles()).toEqual(['config.json', path.basename(backup)]);
      expect(await readFile(backup, 'utf8')).toBe(firstText);
      expect(out).toContain(`This replaces the previous connection (research-bot). Its config was moved to ${backup}.`);
      expect(err).toEqual([]);
    });

    it('leaves the current connection untouched when the new claim fails', async () => {
      const code = await issue();
      expect(await onboard([], code)).toBe(0);
      const firstText = await readFile(configPath(env), 'utf8');
      out.length = 0;
      expect(await onboard([], code)).toBe(1);
      expect(err).toEqual(['Error: That claim code was already used. Create a new one in the web app.']);
      expect(await configFiles()).toEqual(['config.json']);
      expect(await readFile(configPath(env), 'utf8')).toBe(firstText);
    });

    it('overwrites the old config without a backup when --force is given', async () => {
      expect(await onboard()).toBe(0);
      out.length = 0;
      expect(await onboard(['--force'], await issue('second-bot'))).toBe(0);
      expect((await readConfig()).config.agent.name).toBe('second-bot');
      expect(await configFiles()).toEqual(['config.json']);
      expect(out.join('\n')).not.toContain('previous');
    });

    it('moves an invalid existing config aside, without echoing it', async () => {
      await writeCliConfig(env, configFor(generateAgentKey()));
      await writeFile(configPath(env), '{"privateKey":"super-secret-value"');
      expect(await onboard()).toBe(0);
      const backup = path.join(path.dirname(configPath(env)), `config.invalid-${h.clock.now}.json`);
      expect(out).toContain(`The previous config was moved to ${backup}.`);
      expect(await readFile(backup, 'utf8')).toBe('{"privateKey":"super-secret-value"');
      expect([...out, ...err].join('\n')).not.toContain('super-secret-value');
      expect((await readConfig()).config.agent.name).toBe('research-bot');
    });

    describe('errors', () => {
      const failed = async (message: string) => {
        expect(out).toEqual([]);
        expect(err).toEqual([`Error: ${message}`]);
        expect(existsSync(configPath(env))).toBe(false);
      };

      it('says an unknown code is not valid', async () => {
        const code = (await issue()).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
        expect(await onboard([], code)).toBe(1);
        await failed('That claim code is not valid. Check it, or create a new one in the web app.');
      });

      it('says a malformed code is not valid', async () => {
        expect(await onboard([], 'nonsense')).toBe(1);
        await failed('That claim code is not valid. Check it, or create a new one in the web app.');
      });

      it('says a used code was already used', async () => {
        const code = await issue();
        expect(await onboard([], code)).toBe(0);
        await rm(configPath(env));
        out.length = 0;
        expect(await onboard([], code)).toBe(1);
        await failed('That claim code was already used. Create a new one in the web app.');
      });

      it('says an expired code has expired', async () => {
        const code = await issue();
        h.clock.now = T0 + 900;
        expect(await onboard([], code)).toBe(1);
        await failed('That claim code has expired. Create a new one in the web app.');
      });

      it('says to wait on a 429', async () => {
        for (let i = 0; i < 10; i++) expect(await onboard([], 'nonsense')).toBe(1);
        err.length = 0;
        expect(await onboard([], await issue())).toBe(1);
        await failed('Too many attempts. Wait a minute and try again.');
      });

      it('says the facilitator cannot be reached', async () => {
        const code = await issue();
        expect(await run(['onboard', '--claim', code, '--api', 'http://127.0.0.1:1'])).toBe(1);
        await failed('Could not reach PayPer402 at http://127.0.0.1:1.');
      });

      it('reports any other answer by status', async () => {
        const code = await issue();
        const broken = (async () => new Response('{}', { status: 500 })) as typeof fetch;
        expect(await run(['onboard', '--claim', code, '--api', await h.url()], { fetch: broken })).toBe(1);
        await failed('PayPer402 answered 500. Try again.');
        // The same answer for a body that is not what the CLI expects.
        err.length = 0;
        const odd = (async () => new Response('{"agent":1}', { status: 201 })) as typeof fetch;
        expect(await run(['onboard', '--claim', code, '--api', await h.url()], { fetch: odd })).toBe(1);
        await failed('PayPer402 answered 201. Try again.');
      });

      it('rejects a bad --api or --seller before any request', async () => {
        expect(await run(['onboard', '--claim', 'x', '--api', 'ftp://x'])).toBe(1);
        expect(err).toEqual(['Error: --api must be an http(s) URL']);
        err.length = 0;
        expect(await run(['onboard', '--claim', 'x', '--seller', 'not a url'])).toBe(1);
        expect(err).toEqual(['Error: --seller must be an http(s) URL']);
        expect(requests).toEqual([]);
      });

      it('names the created agent when the config cannot be saved, and prints no key', async () => {
        await writeFile(path.join(home, 'blocker'), 'x');
        const blocked = { PAYPER402_HOME: path.join(home, 'blocker', 'sub') };
        expect(await run(['onboard', '--claim', await issue(), '--api', await h.url()], {}, blocked)).toBe(1);
        expect(err).toHaveLength(1);
        expect(err[0]).toMatch(/^Error: The agent research-bot was created, but the config could not be saved: \S+\. Pause it in the web app and create a new claim code\.$/);
        expect(out).toEqual([]);
        expect(h.db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
      });
    });
  });

  describe('status', () => {
    beforeEach(async () => {
      expect(await onboard()).toBe(0);
      out.length = 0;
      requests.length = 0;
    });
    const agentId = async () => (await readConfig()).config.agent.id;
    const text = () => out.join('\n');

    it('prints the status of a ready agent, with signed request details', async () => {
      const seller = h.addSeller().sellerId;
      h.addCommitment({ operatorId, agentId: await agentId(), payTo: seller, amount: 8 });
      h.addCommitment({ operatorId, agentId: await agentId(), payTo: seller, amount: 7 });
      expect(await run(['status'])).toBe(0);
      const { config } = await readConfig();
      expect(out).toEqual([
        `Agent        research-bot  ${config.agent.keyFingerprint}  for Test operator`,
        'State        Ready to pay',
        'Limits       $0.10 per call, $10.00 per day, $5.00 not yet charged, no total limit',
        'Today        $0.15 spent, $9.85 left (this agent: $0.15 in 2 calls)',
        'Not charged  $0.15 in 2 calls',
        'PayPal       Linked',
        'Seller       http://localhost:4021',
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', url: `${await h.url()}/v1/agent/status` });
      expect(requests[0]?.authorization).toMatch(/^PayPer402-Agent /);
      expect([...out, ...err].join('\n')).not.toContain(config.privateKey);
    });

    it('shows the last charge after a settlement', async () => {
      h.addCommitment({ operatorId, agentId: await agentId(), payTo: h.addSeller().sellerId, amount: 8 });
      expect((await h.api('POST', '/v1/settlements', { key: operatorKey })).status).toBe(201);
      expect(await run(['status'])).toBe(0);
      expect(out).toContain('PayPal       Linked. Last charge $0.08, completed, 2026-10-16 12:00 UTC');
      expect(out).toContain('Not charged  $0.00 in 0 calls');
    });

    it('shows a total limit when the operator has one', async () => {
      h.db.prepare('UPDATE operators SET cap_total = 5000 WHERE id = ?').run(operatorId);
      expect(await run(['status'])).toBe(0);
      expect(out).toContain('Limits       $0.10 per call, $10.00 per day, $5.00 not yet charged, $50.00 total');
    });

    it('shows a paused agent', async () => {
      h.db.prepare(`UPDATE agents SET status = 'paused' WHERE id = ?`).run(await agentId());
      expect(await run(['status'])).toBe(0);
      expect(out).toContain('State        Paused by the operator');
    });

    it.each([
      ['stopped_by_payer', 'PayPal stopped by the payer'],
      ['not_linked', 'PayPal not linked'],
      ['link_failed', 'PayPal not linked'],
      ['waiting_for_approval', 'Waiting for PayPal approval'],
      ['unlinking', 'PayPal is being unlinked'],
    ])('shows a %s wallet', async (walletStatus, wording) => {
      h.db.prepare('UPDATE wallets SET status = ? WHERE operator_id = ?').run(walletStatus, operatorId);
      expect(await run(['status'])).toBe(0);
      expect(out).toContain(`State        ${wording}`);
      expect(out).toContain(`PayPal       ${wording}`);
    });

    it.each([
      ['daily', 'UPDATE operators SET cap_daily = 20 WHERE id = ?', 'Daily limit reached'],
      ['unsettled', 'UPDATE operators SET cap_unsettled = 25 WHERE id = ?', 'Waiting for a PayPal charge (not-yet-charged limit reached)'],
      ['total', 'UPDATE operators SET cap_total = 25 WHERE id = ?', 'Total limit reached'],
    ])('shows the %s cap', async (_reason, sql, wording) => {
      h.addCommitment({ operatorId, agentId: await agentId(), payTo: h.addSeller().sellerId, amount: 20 });
      h.db.prepare(sql).run(operatorId);
      expect(await run(['status'])).toBe(0);
      expect(out).toContain(`State        ${wording}`);
    });

    it('prints the body as pretty JSON with --json', async () => {
      expect(await run(['status', '--json'])).toBe(0);
      const body = JSON.parse(text()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['agent', 'blockReason', 'blocked', 'caps', 'operator', 'remainingToday', 'usage', 'wallet']);
      expect(text()).toContain('\n  "agent": {');
    });

    it('signs with the config key even when AGENT_PRIVATE_KEY names another', async () => {
      const other = exportPrivateKeyRaw(generateAgentKey().privateKey);
      expect(await run(['status'], {}, { ...env, AGENT_PRIVATE_KEY: other })).toBe(0);
      expect(out[0]).toContain('research-bot');
    });

    it('says the machine is not connected when there is no config', async () => {
      await rm(configPath(env));
      expect(await run(['status'])).toBe(1);
      expect(out).toEqual([]);
      expect(err).toEqual(['Error: This machine is not connected. Run payper402 onboard --claim <code> first.']);
    });

    it('says the config is invalid without echoing it', async () => {
      await writeFile(configPath(env), '{"privateKey":"super-secret-value"}');
      expect(await run(['status'])).toBe(1);
      expect(err).toEqual([`Error: The config at ${configPath(env)} is invalid. Run payper402 onboard --force.`]);
    });

    it('says the key is not recognised on a 401', async () => {
      h.db.prepare(`UPDATE agents SET kid = 'rotated' WHERE id = ?`).run(await agentId());
      expect(await run(['status'])).toBe(1);
      expect(err).toEqual(["Error: PayPer402 does not recognise this agent's key. Create a new claim code and run payper402 onboard --force."]);
    });

    it('reports an unreachable facilitator and other answers', async () => {
      const read = await readConfig();
      await writeCliConfig(env, { ...read.config, facilitatorUrl: 'http://127.0.0.1:1' });
      expect(await run(['status'])).toBe(1);
      expect(err).toEqual(['Error: Could not reach PayPer402 at http://127.0.0.1:1.']);
      err.length = 0;
      await writeCliConfig(env, read.config);
      const broken = (async () => new Response('{}', { status: 503 })) as typeof fetch;
      expect(await run(['status'], { fetch: broken })).toBe(1);
      expect(err).toEqual(['Error: PayPer402 answered 503. Try again.']);
    });
  });

  describe('mcp', () => {
    it('writes nothing to stdout, and the error to stderr, without a config', async () => {
      const stdout = vi.spyOn(process.stdout, 'write');
      try {
        expect(await run(['mcp'])).toBe(1);
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        stdout.mockRestore();
      }
      expect(out).toEqual([]);
      expect(err).toEqual(['Error: This machine is not connected. Run payper402 onboard --claim <code> first.']);
    });

    it('reports a bad flag value from the agent configuration on stderr', async () => {
      expect(await onboard()).toBe(0);
      out.length = 0;
      expect(await run(['mcp', '--budget', 'lots'])).toBe(1);
      expect(out).toEqual([]);
      expect(err).toEqual(['Error: --budget must be a dollar amount such as 1.00']);
    });

    it('reports an unreachable seller on stderr', async () => {
      expect(await onboard(['--seller', 'http://127.0.0.1:1'])).toBe(0);
      out.length = 0;
      expect(await run(['mcp'])).toBe(1);
      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^Error: /);
    });
  });

  describe('run', () => {
    let demo: Env;
    beforeEach(async () => {
      demo = await startDemoEnv();
    });
    afterEach(async () => {
      await demo.close();
    });

    it('runs the agent with the config key and seller URL, ignoring AGENT_PRIVATE_KEY', async () => {
      await writeCliConfig(env, configFor(demo.key, demo.url));
      const fake = fakeAnthropic([
        message([toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Current coffee price' })]),
        message([toolUse('finish', { answer: 'Coffee is quoted.', spend_explanation: 'I bought one quote.' })]),
      ]);
      const other = exportPrivateKeyRaw(generateAgentKey().privateKey);
      const code = await runPayper402(
        ['run', '--budget', '0.50', 'What', 'is', 'coffee', 'at?'],
        { ...env, AGENT_PRIVATE_KEY: other, SELLER_URL: 'http://127.0.0.1:1' },
        io,
        { anthropic: fake.client },
      );
      expect(err).toEqual([]);
      expect(code).toBe(0);
      expect(out).toContain('[result] completed');
      expect(out.join('\n')).toContain('Coffee is quoted.');
      // The demo seller's facilitator accepted a commitment signed by the config key.
      expect(demo.ledger.all().map((c) => c.kid)).toEqual([demo.key.kid]);
      // The task words reached the model.
      expect(JSON.stringify(fake.requests[0]?.body)).toContain('What is coffee at?');
    });

    it('needs a config, and reports configuration errors from the agent CLI', async () => {
      const fake = fakeAnthropic([]);
      expect(await runPayper402(['run', 'task'], env, io, { anthropic: fake.client })).toBe(1);
      expect(err).toEqual(['Error: This machine is not connected. Run payper402 onboard --claim <code> first.']);
      err.length = 0;
      await writeCliConfig(env, configFor(demo.key, demo.url));
      expect(await runPayper402(['run', '--budget', '0.05', '--max-per-call', '0.10', 'task'], env, io, { anthropic: fake.client })).toBe(1);
      expect(err).toEqual(['The per-call limit must not exceed the budget']);
      expect(fake.requests).toEqual([]);
    });
  });

  describe('mcp server start-up', () => {
    let demo: Env;
    beforeEach(async () => {
      demo = await startDemoEnv();
    });
    afterEach(async () => {
      await demo.close();
    });

    it('connects to an injected transport and lists the three tools', async () => {
      const config = loadAgentConfig({ AGENT_PRIVATE_KEY: exportPrivateKeyRaw(demo.key.privateKey), SELLER_URL: demo.url }, []);
      const logged: string[] = [];
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const started = await startMcpStdio(config, (line) => logged.push(line), serverSide);
      expect(started.ok).toBe(true);
      expect(logged).toEqual(['PayPer402 MCP server ready: Acme Data, 4 services']);
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(clientSide);
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['list_services', 'call_service', 'get_budget']);
      } finally {
        await client.close();
      }
    });

    it('returns the reason instead of throwing when the catalog cannot be read', async () => {
      const config = loadAgentConfig({ AGENT_PRIVATE_KEY: exportPrivateKeyRaw(demo.key.privateKey), SELLER_URL: 'http://127.0.0.1:1' }, []);
      const [serverSide] = InMemoryTransport.createLinkedPair();
      const started = await startMcpStdio(config, () => {}, serverSide);
      expect(started.ok).toBe(false);
    });
  });

  describe('end to end', () => {
    let seller: RunningSeller;
    afterEach(async () => {
      await seller.close();
    });

    it('a claim becomes an agent that pays a seller, and status shows the spend', async () => {
      const sellerAccount = h.addSeller();
      seller = await startSeller({ port: 0, facilitatorUrl: await h.url(), sellerApiKey: sellerAccount.key, ai: new FakeSellerAi() });

      expect(await run(['onboard', '--claim', await issue('research-bot', seller.url), '--api', await h.url()])).toBe(0);
      const { config, privateKey } = await readConfig();
      expect(config.sellerUrl).toBe(seller.url);

      // The harness clock is fixed, so commitments carry the same clock.
      const session = await openSession({
        sellerUrl: config.sellerUrl,
        privateKey,
        budgetCents: 100,
        maxPerCallCents: 10,
        nowSeconds: () => h.clock.now,
      });
      const outcome = await session.call('quote', { symbol: 'KC' }, 'Current coffee price');
      expect(outcome.ok).toBe(true);
      expect(h.db.prepare('SELECT agent_id, amount FROM commitments').all()).toEqual([{ agent_id: config.agent.id, amount: 2 }]);

      out.length = 0;
      expect(await run(['status'])).toBe(0);
      expect(out).toContain('Today        $0.02 spent, $9.98 left (this agent: $0.02 in 1 call)');
      expect(out).toContain('Not charged  $0.02 in 1 call');
      expect(out).toContain('State        Ready to pay');

      out.length = 0;
      expect(await run(['status', '--json'])).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ agent: { id: config.agent.id, spentToday: 2, callsToday: 1 } });
    });
  });
});

/** A config for an agent key that exists only in a test seller's registry. */
function configFor(key: ReturnType<typeof generateAgentKey>, sellerUrl = 'http://localhost:4021'): CliConfig {
  return {
    version: 1,
    facilitatorUrl: 'http://localhost:4020',
    sellerUrl,
    operatorName: 'Test operator',
    agent: { id: 'agt_test', name: 'research-bot', kid: key.kid, keyFingerprint: `ed25519:${key.kid.slice(0, 6)}${key.kid.slice(-4)}` },
    privateKey: exportPrivateKeyRaw(key.privateKey),
    createdAt: T0,
  };
}
