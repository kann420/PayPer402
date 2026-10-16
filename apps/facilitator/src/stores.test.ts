/**
 * Store contract tests: the scheme package's ledger and registry expectations, run against the
 * SQLite implementations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utcDayStart, type Caps, type CommitmentRecord } from '@payper402/scheme-paypal';
import { SqliteAgentRegistry, SqliteCommitmentLedger } from './stores';
import { createHarness, T0, type Harness } from './test-support';

const CAPS: Caps = { perCall: 25, daily: 100, unsettled: 50 };

describe('SqliteCommitmentLedger', () => {
  let h: Harness;
  let operatorId: string;
  let agentId: string;
  let ledger: SqliteCommitmentLedger;
  let recorded: CommitmentRecord[];
  let counter = 0;

  const entry = (overrides: Partial<Omit<CommitmentRecord, 'state'>> = {}): Omit<CommitmentRecord, 'state'> => {
    counter += 1;
    return {
      id: `id_${counter}`,
      kid: 'kid_1',
      agentId,
      operatorId,
      payTo: 'seller_1',
      resourceUrl: 'https://seller.test/x',
      maxAmount: 10,
      amount: 10,
      iat: T0,
      recordedAt: T0,
      payloadHash: `hash_${counter}`,
      ...overrides,
    };
  };

  beforeEach(() => {
    h = createHarness();
    operatorId = h.addOperator().operatorId;
    agentId = h.addAgent(operatorId).agentId;
    recorded = [];
    ledger = new SqliteCommitmentLedger(h.db, (record) => recorded.push(record));
  });
  afterEach(async () => {
    await h.close();
  });

  it('records a commitment as unsettled and reports the new snapshot', async () => {
    const e = entry({ amount: 7 });
    const result = await ledger.record(e, CAPS, T0);
    expect(result).toEqual({
      ok: true,
      duplicate: false,
      record: { ...e, state: 'unsettled' },
      snapshot: { spentToday: 7, unsettled: 7, spentTotal: 7 },
    });
    expect(await ledger.has(e.id)).toBe(true);
    expect(await ledger.get(e.id)).toEqual({ ...e, state: 'unsettled' });
    expect(recorded).toEqual([{ ...e, state: 'unsettled' }]);
  });

  it('returns the original record for an identical retry, and replay for a different payload', async () => {
    const e = entry({ amount: 7 });
    await ledger.record(e, CAPS, T0);
    const retry = await ledger.record({ ...e, amount: 3 }, CAPS, T0);
    expect(retry).toMatchObject({ ok: true, duplicate: true, record: { amount: 7 } });
    expect(await ledger.record({ ...e, payloadHash: 'other' }, CAPS, T0)).toEqual({ ok: false, reason: 'replay' });
    expect(recorded).toHaveLength(1);
    expect(h.commitmentStates(operatorId)).toEqual({ unsettled: 1 });
  });

  it('enforces caps in binding order and inserts nothing on failure', async () => {
    expect(await ledger.record(entry({ amount: 26 }), CAPS, T0)).toEqual({ ok: false, reason: 'cap_exceeded', cap: 'perCall' });
    await ledger.record(entry({ amount: 25 }), { ...CAPS, daily: 30 }, T0);
    expect(await ledger.record(entry({ amount: 10 }), { ...CAPS, daily: 30 }, T0)).toMatchObject({ cap: 'daily' });
    expect(await ledger.record(entry({ amount: 25, recordedAt: T0 }), { ...CAPS, unsettled: 40 }, T0)).toMatchObject({
      cap: 'unsettled',
    });
    expect(await ledger.record(entry({ amount: 10 }), { ...CAPS, total: 30 }, T0)).toMatchObject({ cap: 'total' });
    expect(h.commitmentStates(operatorId)).toEqual({ unsettled: 1 });
    expect(recorded).toHaveLength(1);
  });

  it('is atomic under parallel record calls', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.record(entry(), CAPS, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === 'cap_exceeded')).toHaveLength(15);
    expect((await ledger.snapshot(operatorId, T0)).unsettled).toBe(50);
  });

  it('records the same id only once under parallel calls', async () => {
    const e = entry();
    const results = await Promise.all([ledger.record(e, CAPS, T0), ledger.record(e, CAPS, T0)]);
    expect(results.map((r) => r.ok && r.duplicate)).toEqual([false, true]);
    expect(recorded).toHaveLength(1);
  });

  it('counts the daily total per UTC day of recordedAt and unsettled by state', async () => {
    const midnight = utcDayStart(T0) + 86_400;
    const yesterday = entry({ amount: 10, recordedAt: midnight - 1 });
    await ledger.record(yesterday, CAPS, midnight - 1);
    await ledger.record(entry({ amount: 5, recordedAt: midnight }), CAPS, midnight);
    h.db.prepare(`UPDATE commitments SET state = 'settled' WHERE id = ?`).run(yesterday.id);
    expect(await ledger.snapshot(operatorId, midnight - 1)).toEqual({ spentToday: 10, unsettled: 5, spentTotal: 15 });
    expect(await ledger.snapshot(operatorId, midnight)).toEqual({ spentToday: 5, unsettled: 5, spentTotal: 15 });
    expect(await ledger.snapshot('op_other', midnight)).toEqual({ spentToday: 0, unsettled: 0, spentTotal: 0 });
  });

  it('counts settling as unsettled and uncollectable only in totals', async () => {
    const a = entry({ amount: 5 });
    const b = entry({ amount: 7 });
    await ledger.record(a, CAPS, T0);
    await ledger.record(b, CAPS, T0);
    h.db.prepare(`UPDATE commitments SET state = 'settling' WHERE id = ?`).run(a.id);
    h.db.prepare(`UPDATE commitments SET state = 'uncollectable' WHERE id = ?`).run(b.id);
    expect(await ledger.snapshot(operatorId, T0)).toEqual({ spentToday: 12, unsettled: 5, spentTotal: 12 });
  });

  it('catches errors thrown by onRecorded', async () => {
    const throwing = new SqliteCommitmentLedger(h.db, () => {
      throw new Error('hook failed');
    });
    await expect(throwing.record(entry(), CAPS, T0)).resolves.toMatchObject({ ok: true, duplicate: false });
  });
});

describe('SqliteAgentRegistry', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('maps agents and their status', async () => {
    const { operatorId } = h.addOperator();
    const { agentId, key } = h.addAgent(operatorId);
    const registry = new SqliteAgentRegistry(h.db);
    expect(await registry.getAgentByKid(key.kid)).toEqual({
      agentId,
      kid: key.kid,
      publicKeyX: key.publicKeyX,
      operatorId,
      status: 'active',
    });
    h.db.prepare(`UPDATE agents SET status = 'paused'`).run();
    expect((await registry.getAgentByKid(key.kid))?.status).toBe('disabled');
    expect(await registry.getAgentByKid('missing')).toBeUndefined();
  });

  it.each([
    ['active', 'active'],
    ['stopped_by_payer', 'revoked'],
    ['not_linked', 'unlinked'],
    ['waiting_for_approval', 'unlinked'],
    ['unlinking', 'unlinked'],
    ['link_failed', 'unlinked'],
  ] as const)('maps wallet status %s to %s, with caps', async (status, expected) => {
    const { operatorId } = h.addOperator({ caps: { perCall: 5, daily: 50, unsettled: 20 }, wallet: status });
    const registry = new SqliteAgentRegistry(h.db);
    expect(await registry.getOperator(operatorId)).toEqual({
      operatorId,
      walletStatus: expected,
      caps: { perCall: 5, daily: 50, unsettled: 20 },
    });
  });

  it('includes total only when set', async () => {
    const { operatorId } = h.addOperator({ caps: { perCall: 5, daily: 50, unsettled: 20, total: 99 } });
    expect((await new SqliteAgentRegistry(h.db).getOperator(operatorId))?.caps).toEqual({
      perCall: 5,
      daily: 50,
      unsettled: 20,
      total: 99,
    });
    expect(await new SqliteAgentRegistry(h.db).getOperator('missing')).toBeUndefined();
  });
});
