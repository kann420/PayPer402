import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiError, createHarness, networkError, T0, type Harness } from '@payper402/facilitator/test-support';
import { generateAgentKey } from '@payper402/scheme-paypal';
import { DemoFail, checkLedger, ensureAgent, settleRun, settlementDecision, type Api, type SettleDeps } from './demo-steps';

let h: Harness;
let operatorId: string;
let key: string;
let api: Api;

beforeEach(() => {
  h = createHarness();
  ({ operatorId, key } = h.addOperator({ caps: { perCall: 10, daily: 1000, unsettled: 500 } }));
  api = (method, path, body) => h.api(method, path, { key, ...(body === undefined ? {} : { body }) });
});

afterEach(async () => {
  await h.close();
});

describe('ensureAgent (§9 step 3)', () => {
  const agentKey = generateAgentKey();
  const input = { name: 'research-bot', publicKeyX: agentKey.publicKeyX, kid: agentKey.kid };

  it('creates the agent on the first run (201)', async () => {
    const agent = await ensureAgent(api, input);
    expect(agent.id).toMatch(/^agt_/);
    expect(agent.status).toBe('active');
  });

  it('finds the agent by kid on later runs (409 agent_key_exists)', async () => {
    const first = await ensureAgent(api, input);
    expect(await ensureAgent(api, input)).toEqual(first);
  });

  it('keeps a paused agent paused', async () => {
    const first = await ensureAgent(api, input);
    await api('PATCH', `/v1/agents/${first.id}`, { status: 'paused' });
    expect(await ensureAgent(api, input)).toEqual({ id: first.id, status: 'paused' });
  });

  it('fails when the key is registered to another operator', async () => {
    const other = h.addOperator();
    const otherApi: Api = (method, path, body) => h.api(method, path, { key: other.key, ...(body === undefined ? {} : { body }) });
    await ensureAgent(otherApi, input);
    await expect(ensureAgent(api, input)).rejects.toThrow(new DemoFail('The agent key is registered to another operator.'));
  });
});

describe('checkLedger (§9 step 7)', () => {
  let agentId: string;
  beforeEach(() => {
    ({ agentId } = h.addAgent(operatorId));
  });

  const add = (amount: number, recordedAt = T0) => h.addCommitment({ operatorId, agentId, payTo: 'sel_x', amount, recordedAt });

  it('matches the report ids and amounts, ignoring commitments before the run', async () => {
    add(9, T0 - 100);
    const a = add(2);
    const b = add(5);
    expect(await checkLedger(api, { agentId, sinceSeconds: T0, paid: [{ commitmentId: a, amountCents: 2 }, { commitmentId: b, amountCents: 5 }] })).toEqual({
      count: 2,
      totalCents: 7,
    });
  });

  it('matches an empty run', async () => {
    expect(await checkLedger(api, { agentId, sinceSeconds: T0, paid: [] })).toEqual({ count: 0, totalCents: 0 });
  });

  it('fails on a ledger commitment that is not in the report', async () => {
    const a = add(2);
    add(5);
    await expect(checkLedger(api, { agentId, sinceSeconds: T0, paid: [{ commitmentId: a, amountCents: 2 }] })).rejects.toThrow(
      /1 ledger commitment\(s\) not in the report/,
    );
  });

  it('fails on a reported commitment that is not in the ledger, and on a paid call without an id', async () => {
    const a = add(2);
    await expect(
      checkLedger(api, { agentId, sinceSeconds: T0, paid: [{ commitmentId: a, amountCents: 2 }, { commitmentId: 'cmt_nope', amountCents: 5 }] }),
    ).rejects.toThrow(/1 reported commitment\(s\) not in the ledger \(cmt_nope\)/);
    await expect(checkLedger(api, { agentId, sinceSeconds: T0, paid: [{ commitmentId: null, amountCents: 2 }] })).rejects.toThrow(DemoFail);
  });

  it('fails on an amount mismatch', async () => {
    const a = add(2);
    await expect(checkLedger(api, { agentId, sinceSeconds: T0, paid: [{ commitmentId: a, amountCents: 3 }] })).rejects.toThrow(
      `Ledger mismatch: commitment ${a} records 2 cents, the agent reported 3.`,
    );
  });
});

describe('settleRun (§9 step 8)', () => {
  let agentId: string;
  let ids: string[];
  let deps: SettleDeps;
  let sleeps: number;

  beforeEach(() => {
    ({ agentId } = h.addAgent(operatorId));
    h.activateWallet(operatorId);
    ids = [2, 5].map((amount) => h.addCommitment({ operatorId, agentId, payTo: 'sel_x', amount }));
    sleeps = 0;
    deps = {
      api,
      now: () => h.clock.now * 1000,
      sleep: async () => {
        sleeps += 1;
        h.clock.now += 60;
        await h.services.jobs.runTick();
        await h.services.settlements.background.idle();
      },
    };
  });

  const input = () => ({ agentId, sinceSeconds: T0, commitmentIds: ids });

  it('201 completed: checks the settlement and returns its PayPal ids', async () => {
    const [summary, ...rest] = await settleRun(deps, input());
    expect(rest).toEqual([]);
    expect(summary).toMatchObject({ amountCents: 7, calls: 2 });
    expect(summary?.paypalOrderId).toMatch(/^ORDER-/);
    expect(summary?.paypalCaptureId).toMatch(/^CAP-/);
    expect(h.paypal.callsOf('chargeVaultedWallet')).toEqual([[expect.objectContaining({ amountCents: 7 })]]);
    h.checkInvariants();
  });

  it('201 pending, then completed after a retry', async () => {
    h.paypal.chargeScripts.push(() => {
      throw networkError();
    });
    const [summary] = await settleRun(deps, input());
    expect(summary).toMatchObject({ amountCents: 7 });
    expect(sleeps).toBeGreaterThan(0);
    expect(h.paypal.callsOf('chargeVaultedWallet')).toHaveLength(2);
  });

  it('201 failed: fails at once with the failure code', async () => {
    h.paypal.chargeScripts.push(() => {
      throw apiError(422, ['PAYER_CANNOT_PAY']);
    });
    await expect(settleRun(deps, input())).rejects.toThrow(/is failed: /);
    expect(sleeps).toBe(0);
  });

  it('201 needs_review: fails at once', async () => {
    h.paypal.chargeScripts.push(() => {
      throw apiError(400, ['MALFORMED_REQUEST_JSON']);
    });
    await expect(settleRun(deps, input())).rejects.toThrow(/is needs_review: paypal_error \(MALFORMED_REQUEST_JSON\)/);
  });

  it('409 settlement_in_progress: waits for the pending settlement, retries once, and proceeds', async () => {
    const gate = h.paypal.hold('chargeVaultedWallet');
    const background = api('POST', '/v1/settlements');
    await gate.entered;
    deps.sleep = async () => {
      sleeps += 1;
      gate.release();
      await background;
    };
    const [summary] = await settleRun(deps, input());
    expect(summary).toMatchObject({ amountCents: 7 });
    expect(sleeps).toBe(1);
  });

  it('409 nothing_to_settle: a trigger already claimed the calls; proceeds', async () => {
    expect((await api('POST', '/v1/settlements')).status).toBe(201);
    const [summary] = await settleRun(deps, input());
    expect(summary).toMatchObject({ amountCents: 7 });
  });

  it('409 wallet_not_active: fails with that reason', async () => {
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer' WHERE operator_id = ?`).run(operatorId);
    await expect(settleRun(deps, input())).rejects.toThrow(/wallet_not_active/);
  });
});

describe('settlementDecision (§9 step 8 gating)', () => {
  it('skips with --no-settle, then with no paid calls, then with a wallet not active after step 4', () => {
    expect(settlementDecision({ settleFlag: false, paidCalls: 3, walletStatusAfterLink: 'active' })).toEqual({
      settle: false,
      reason: 'Settlement skipped (--no-settle).',
    });
    // The stopped-wallet scene: inactive wallet and no paid calls ends PASS without settling.
    expect(settlementDecision({ settleFlag: true, paidCalls: 0, walletStatusAfterLink: 'stopped_by_payer' })).toEqual({
      settle: false,
      reason: 'Settlement skipped: the run made no paid calls.',
    });
    expect(settlementDecision({ settleFlag: true, paidCalls: 2, walletStatusAfterLink: 'not_linked' })).toEqual({
      settle: false,
      reason: 'Settlement skipped: the wallet is not_linked.',
    });
    expect(settlementDecision({ settleFlag: true, paidCalls: 2, walletStatusAfterLink: 'active' })).toEqual({ settle: true });
  });

  it('a wallet revoked after the run still settles, and the 409 wallet_not_active fails the demo', async () => {
    const { agentId } = h.addAgent(operatorId);
    h.activateWallet(operatorId);
    const ids = [h.addCommitment({ operatorId, agentId, payTo: 'sel_x', amount: 2 })];
    const decision = settlementDecision({ settleFlag: true, paidCalls: ids.length, walletStatusAfterLink: h.wallet(operatorId).status });
    expect(decision).toEqual({ settle: true });
    // Revoked between the agent run and step 8.
    h.db.prepare(`UPDATE wallets SET status = 'stopped_by_payer' WHERE operator_id = ?`).run(operatorId);
    const deps: SettleDeps = { api, now: () => h.clock.now * 1000, sleep: async () => undefined };
    await expect(settleRun(deps, { agentId, sinceSeconds: T0, commitmentIds: ids })).rejects.toThrow(/wallet_not_active/);
    expect(h.paypal.callsOf('chargeVaultedWallet')).toEqual([]);
  });
});
