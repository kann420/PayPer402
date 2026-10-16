import { describe, expect, it } from 'vitest';
import { InMemoryAgentRegistry, InMemoryCommitmentLedger } from './memory';
import { generateAgentKey } from './keys';
import { exceededCap, utcDayStart, type Caps, type CommitmentRecord } from './stores';

const T0 = 1_760_500_000;
const CAPS: Caps = { perCall: 25, daily: 100, unsettled: 50 };

let counter = 0;
function entry(overrides: Partial<Omit<CommitmentRecord, 'state'>> = {}): Omit<CommitmentRecord, 'state'> {
  counter += 1;
  return {
    id: `id_${counter}`,
    kid: 'kid_1',
    agentId: 'agent_1',
    operatorId: 'op_1',
    payTo: 'seller_1',
    resourceUrl: 'https://seller.test/x',
    maxAmount: 10,
    amount: 10,
    iat: T0,
    recordedAt: T0,
    payloadHash: `hash_${counter}`,
    ...overrides,
  };
}

describe('InMemoryCommitmentLedger', () => {
  it('records a commitment as unsettled and reports the new snapshot', async () => {
    const ledger = new InMemoryCommitmentLedger();
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
  });

  it('returns the original record for an identical retry, and replay for a different payload', async () => {
    const ledger = new InMemoryCommitmentLedger();
    const e = entry({ amount: 7 });
    await ledger.record(e, CAPS, T0);
    const retry = await ledger.record({ ...e, amount: 3 }, CAPS, T0);
    expect(retry).toMatchObject({ ok: true, duplicate: true, record: { amount: 7 } });
    expect(await ledger.record({ ...e, payloadHash: 'other' }, CAPS, T0)).toEqual({ ok: false, reason: 'replay' });
    expect(ledger.size).toBe(1);
  });

  it('enforces caps in order and inserts nothing on failure', async () => {
    const ledger = new InMemoryCommitmentLedger();
    expect(await ledger.record(entry({ amount: 26 }), CAPS, T0)).toEqual({
      ok: false,
      reason: 'cap_exceeded',
      cap: 'perCall',
    });
    expect(ledger.size).toBe(0);
  });

  it('is atomic under parallel record calls', async () => {
    const ledger = new InMemoryCommitmentLedger();
    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.record(entry(), CAPS, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === 'cap_exceeded')).toHaveLength(15);
    expect((await ledger.snapshot('op_1', T0)).unsettled).toBe(50);
  });

  it('records the same id only once under parallel calls', async () => {
    const ledger = new InMemoryCommitmentLedger();
    const e = entry();
    const results = await Promise.all([ledger.record(e, CAPS, T0), ledger.record(e, CAPS, T0)]);
    expect(results.map((r) => r.ok && r.duplicate)).toEqual([false, true]);
    expect(ledger.size).toBe(1);
  });

  it('counts the daily total per UTC day of recordedAt and unsettled by state', async () => {
    const ledger = new InMemoryCommitmentLedger();
    const midnight = utcDayStart(T0) + 86_400;
    const yesterday = entry({ amount: 10, recordedAt: midnight - 1 });
    await ledger.record(yesterday, CAPS, midnight - 1);
    await ledger.record(entry({ amount: 5, recordedAt: midnight }), CAPS, midnight);
    ledger.setState(yesterday.id, 'settled');
    expect(await ledger.snapshot('op_1', midnight - 1)).toEqual({ spentToday: 10, unsettled: 5, spentTotal: 15 });
    expect(await ledger.snapshot('op_1', midnight)).toEqual({ spentToday: 5, unsettled: 5, spentTotal: 15 });
    expect(await ledger.snapshot('op_other', midnight)).toEqual({ spentToday: 0, unsettled: 0, spentTotal: 0 });
  });
});

describe('exceededCap', () => {
  const zero = { spentToday: 0, unsettled: 0, spentTotal: 0 };

  it.each([
    ['perCall', { ...CAPS, perCall: Number.NaN }],
    ['daily', { ...CAPS, daily: Number.NaN }],
    ['unsettled', { ...CAPS, unsettled: undefined as unknown as number }],
    ['total', { ...CAPS, total: Number.NaN }],
  ])('fails closed when %s is not a number', (cap, caps) => {
    expect(exceededCap(1, zero, caps)).toBe(cap);
  });

  it('fails closed on a NaN amount', () => {
    expect(exceededCap(Number.NaN, zero, CAPS)).toBe('perCall');
  });
});

describe('InMemoryAgentRegistry', () => {
  const agentFor = (key = generateAgentKey()) => ({
    agentId: 'a',
    kid: key.kid,
    publicKeyX: key.publicKeyX,
    operatorId: 'op_1',
    status: 'active' as const,
  });

  it.each([
    ['NaN', { ...CAPS, daily: Number.NaN }],
    ['undefined', { ...CAPS, perCall: undefined as unknown as number }],
    ['negative', { ...CAPS, unsettled: -1 }],
    ['fractional', { ...CAPS, perCall: 1.5 }],
    ['a NaN total', { ...CAPS, total: Number.NaN }],
  ])('rejects %s caps', (_label, caps) => {
    expect(() => new InMemoryAgentRegistry().addOperator({ operatorId: 'op', walletStatus: 'active', caps })).toThrow(
      TypeError,
    );
    const registry = new InMemoryAgentRegistry().addOperator({ operatorId: 'op', walletStatus: 'active', caps: CAPS });
    expect(() => registry.setCaps('op', caps)).toThrow(TypeError);
  });

  it('rejects missing caps with a clear message', () => {
    const caps = undefined as unknown as Caps;
    expect(() => new InMemoryAgentRegistry().addOperator({ operatorId: 'op', walletStatus: 'active', caps })).toThrow(
      /Caps must be an object/,
    );
  });

  it('rejects an operator id that is already registered', () => {
    const registry = new InMemoryAgentRegistry().addOperator({ operatorId: 'op', walletStatus: 'active', caps: CAPS });
    expect(() => registry.addOperator({ operatorId: 'op', walletStatus: 'revoked', caps: CAPS })).toThrow(
      /already registered/,
    );
  });

  it('rejects an agent whose kid does not match its public key', () => {
    const registry = new InMemoryAgentRegistry();
    expect(() => registry.addAgent({ ...agentFor(), kid: generateAgentKey().kid })).toThrow();
    expect(() => registry.addAgent({ ...agentFor(), publicKeyX: 'not-a-key' })).toThrow();
  });

  it('rejects a kid that is already registered', () => {
    const key = generateAgentKey();
    const registry = new InMemoryAgentRegistry().addAgent(agentFor(key));
    expect(() => registry.addAgent({ ...agentFor(key), agentId: 'b' })).toThrow(/already registered/);
  });

  it('returns copies so callers cannot mutate stored records', async () => {
    const registry = new InMemoryAgentRegistry()
      .addOperator({ operatorId: 'op_1', walletStatus: 'active', caps: CAPS })
      .addAgent(agentFor());
    const operator = await registry.getOperator('op_1');
    if (operator) operator.caps.perCall = 1;
    expect((await registry.getOperator('op_1'))?.caps.perCall).toBe(25);
    registry.setWalletStatus('op_1', 'revoked');
    expect((await registry.getOperator('op_1'))?.walletStatus).toBe('revoked');
    expect(await registry.getAgentByKid('missing')).toBeUndefined();
  });
});
