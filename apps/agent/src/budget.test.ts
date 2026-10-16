import { describe, expect, it } from 'vitest';
import { Budget } from './budget';

describe('Budget', () => {
  it('does reserve, commit, release and uncertain arithmetic', () => {
    const budget = new Budget(100, 10);
    const a = budget.reserve(5);
    const b = budget.reserve(7);
    const c = budget.reserve(3);
    if (!a || !b || !c) throw new Error('reservations failed');
    expect(budget.snapshot()).toEqual({ budgetCents: 100, maxPerCallCents: 10, spentCents: 0, uncertainCents: 0, reservedCents: 15, remainingCents: 85 });
    expect(budget.commit(a, 5)).toEqual({ committedCents: 5, overReported: false });
    budget.release(b);
    budget.markUncertain(c);
    expect(budget.snapshot()).toEqual({ budgetCents: 100, maxPerCallCents: 10, spentCents: 5, uncertainCents: 3, reservedCents: 0, remainingCents: 92 });
  });

  it('enforces maxPerCall and the remaining budget', () => {
    const budget = new Budget(12, 10);
    expect(budget.reserve(11)).toBeUndefined();
    expect(budget.reserve(10)).toBeDefined();
    expect(budget.reserve(3)).toBeUndefined();
    expect(budget.reserve(2)).toBeDefined();
    expect(budget.remainingCents).toBe(0);
  });

  it('20 parallel reservations against a budget that fits 7: exactly 7 succeed', async () => {
    const budget = new Budget(14, 2);
    const results = await Promise.all(Array.from({ length: 20 }, async () => budget.reserve(2)));
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(budget.remainingCents).toBe(0);
  });

  it('throws when a reservation is settled twice', () => {
    const budget = new Budget(10, 5);
    const r = budget.reserve(5);
    if (!r) throw new Error('reservation failed');
    budget.commit(r, 5);
    expect(() => budget.release(r)).toThrow('already settled');
    expect(() => budget.commit(r, 5)).toThrow('already settled');
    expect(() => budget.markUncertain(r)).toThrow('already settled');
  });

  it('commits a lower actual amount (dynamic pricing)', () => {
    const budget = new Budget(10, 5);
    const r = budget.reserve(5);
    if (!r) throw new Error('reservation failed');
    expect(budget.commit(r, 3)).toEqual({ committedCents: 3, overReported: false });
    expect(budget.spentCents).toBe(3);
    expect(budget.remainingCents).toBe(7);
  });

  it('commits only the reserved amount when a higher amount is reported', () => {
    const budget = new Budget(10, 5);
    const r = budget.reserve(4);
    if (!r) throw new Error('reservation failed');
    expect(budget.commit(r, 9)).toEqual({ committedCents: 4, overReported: true });
    expect(budget.spentCents).toBe(4);
  });

  it('rejects invalid limits', () => {
    expect(() => new Budget(0, 0)).toThrow(RangeError);
    expect(() => new Budget(10, 11)).toThrow(RangeError);
    expect(() => new Budget(10.5, 1)).toThrow(RangeError);
  });
});
