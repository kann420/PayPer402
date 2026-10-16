import { describe, expect, it } from 'vitest';
import { caught, ceil2, choosePin, computePolicy, confusion, falselyBlocked, floor2, loosen, outcome, type CaseRuns, type Run } from './eval-policy';
import type { SpendPolicy } from './spend-check';

const runs = (...pairs: [number, number][]): Run[] => pairs.map(([servesTask, alreadyCovered]) => ({ servesTask, alreadyCovered }));
const three = (servesTask: number, alreadyCovered: number) => runs([servesTask, alreadyCovered], [servesTask, alreadyCovered], [servesTask, alreadyCovered]);

let n = 0;
const allow = (r: Run[], holdout = false): CaseRuns => ({ id: `allow-${(n += 1)}`, label: 'allow', holdout, runs: r });
const notNeeded = (r: Run[], holdout = false): CaseRuns => ({ id: `nn-${(n += 1)}`, label: 'not_needed', holdout, runs: r });
const covered = (r: Run[], holdout = false): CaseRuns => ({ id: `cov-${(n += 1)}`, label: 'already_covered', holdout, runs: r });

/** Two caught cases per block label, at values that any in-range threshold catches. */
const catches = () => [notNeeded(three(0.05, 0.02)), notNeeded(three(0.06, 0.02)), covered(three(0.7, 0.97)), covered(three(0.7, 0.98))];

describe('rounding', () => {
  it('rounds in the safe direction despite floating-point noise', () => {
    expect(floor2(0.62 - 0.05)).toBe(0.57);
    expect(floor2(0.574 - 0.05)).toBe(0.52);
    expect(ceil2(0.06 + 0.05)).toBe(0.11);
    expect(ceil2(0.051 + 0.05)).toBe(0.11);
    expect(ceil2(0.93 + 0.05)).toBe(0.98);
    expect(floor2(0.12 - 0.05)).toBe(0.07);
  });
});

describe('computePolicy', () => {
  it('minAllowServes 0.574: raw 0.52, capped at 0.50, in range, enforced with 2 catches', () => {
    const result = computePolicy([allow(three(0.574, 0.03)), ...catches()]);
    expect(result.minAllowServes).toBe(0.574);
    expect(result.raw.not_needed).toBe(0.52);
    expect(result.computed.not_needed).toBe(0.5);
    expect(result.inRange.not_needed).toBe(true);
    expect(result.policy.notNeededBelow).toBe(0.5);
    expect(result.policy.modes.not_needed).toBe('enforce');
  });

  it('minAllowServes 0.12: raw 0.07, clamped to 0.10, observes', () => {
    const result = computePolicy([allow(three(0.12, 0.03)), ...catches()]);
    expect(result.raw.not_needed).toBe(0.07);
    expect(result.inRange.not_needed).toBe(false);
    expect(result.policy.notNeededBelow).toBe(0.1);
    expect(result.policy.modes.not_needed).toBe('observe');
  });

  it('maxAllowCovered 0.93: raw 0.98, clamped to 0.95, observes', () => {
    const result = computePolicy([allow(three(0.7, 0.93)), ...catches()]);
    expect(result.raw.already_covered).toBe(0.98);
    expect(result.policy.coveredAbove).toBe(0.95);
    expect(result.policy.modes.already_covered).toBe('observe');
  });

  it('maxAllowCovered 0.051: raw 0.11 (rounded up), raised to the 0.50 floor, enforced', () => {
    const result = computePolicy([allow(three(0.7, 0.051)), ...catches()]);
    expect(result.maxAllowCovered).toBe(0.051);
    expect(result.raw.already_covered).toBe(0.11);
    expect(result.computed.already_covered).toBe(0.5);
    expect(result.policy.coveredAbove).toBe(0.5);
    expect(result.policy.modes.already_covered).toBe('enforce');
  });

  it('uses the lowest serves and highest covered over all allow runs', () => {
    const result = computePolicy([allow(runs([0.8, 0.02], [0.7, 0.04], [0.75, 0.03])), allow(three(0.65, 0.1)), ...catches()]);
    expect(result.minAllowServes).toBe(0.65);
    expect(result.maxAllowCovered).toBe(0.1);
    expect(result.policy.notNeededBelow).toBe(0.5);
  });

  it('the mode bar: 1 caught case observes, 2 enforce; a case caught in only 2 of 3 runs does not count', () => {
    const one = computePolicy([allow(three(0.7, 0.03)), notNeeded(three(0.1, 0.02)), notNeeded(runs([0.1, 0.02], [0.1, 0.02], [0.6, 0.02]))]);
    expect(one.caught.not_needed).toBe(1);
    expect(one.policy.modes.not_needed).toBe('observe');
    const two = computePolicy([allow(three(0.7, 0.03)), notNeeded(three(0.1, 0.02)), notNeeded(three(0.2, 0.02))]);
    expect(two.caught.not_needed).toBe(2);
    expect(two.policy.modes.not_needed).toBe('enforce');
    expect(two.policy.modes.already_covered).toBe('observe');
  });

  it('a cross-rule match is not a catch', () => {
    // already_covered cases matched only by not_needed.
    const result = computePolicy([allow(three(0.7, 0.03)), covered(three(0.1, 0.2)), covered(three(0.1, 0.2))]);
    expect(result.caught.already_covered).toBe(0);
    expect(result.policy.modes.already_covered).toBe('observe');
    expect(caught(covered(three(0.1, 0.2)), result.policy)).toBe(false);
  });

  it('needs allow runs', () => {
    expect(() => computePolicy([notNeeded(three(0.1, 0.1))])).toThrow();
  });
});

describe('loosen', () => {
  const tuning = [allow(three(0.7, 0.03)), notNeeded(three(0.1, 0.02)), notNeeded(three(0.2, 0.02)), covered(three(0.7, 0.9)), covered(three(0.7, 0.92))];
  const base = computePolicy(tuning).policy;

  it('the starting policy enforces both rules', () => {
    expect(base).toEqual({ notNeededBelow: 0.5, coveredAbove: 0.5, modes: { not_needed: 'enforce', already_covered: 'enforce' } });
  });

  it('changes nothing when no hold-out allow run is falsely blocked', () => {
    expect(loosen(base, tuning, [allow(three(0.6, 0.1), true), notNeeded(three(0.1, 0.1), true)])).toEqual({ policy: base, loosenings: [] });
  });

  it('loosening that stays in range keeps the mode', () => {
    const result = loosen(base, tuning, [allow(runs([0.6, 0.1], [0.42, 0.1], [0.5, 0.1]), true)]);
    expect(result.policy.notNeededBelow).toBe(0.37);
    expect(result.policy.modes.not_needed).toBe('enforce');
    expect(result.loosenings).toEqual([expect.objectContaining({ rule: 'not_needed', value: 0.42, from: 0.5, to: 0.37, mode: 'enforce' })]);
    expect(falselyBlocked(allow(runs([0.42, 0.1]), true), result.policy)).toBe(false);
  });

  it('loosening that leaves the range clamps the threshold and observes', () => {
    const result = loosen(base, tuning, [allow(runs([0.12, 0.1]), true)]);
    expect(result.policy.notNeededBelow).toBe(0.1);
    expect(result.policy.modes.not_needed).toBe('observe');
    const coveredResult = loosen(base, tuning, [allow(runs([0.7, 0.93]), true)]);
    expect(coveredResult.policy.coveredAbove).toBe(0.95);
    expect(coveredResult.policy.modes.already_covered).toBe('observe');
  });

  it('the step-3 re-check turns a rule to observe when the new threshold catches fewer than 2 tuning cases', () => {
    // At 0.15 only the 0.1 not_needed case is caught.
    const result = loosen(base, tuning, [allow(runs([0.2, 0.1]), true)]);
    expect(result.policy.notNeededBelow).toBe(0.15);
    expect(result.policy.modes.not_needed).toBe('observe');
    // already_covered: moving past 0.91 keeps only the 0.92 case caught.
    const coveredResult = loosen(base, tuning, [allow(runs([0.7, 0.86]), true)]);
    expect(coveredResult.policy.coveredAbove).toBe(0.91);
    expect(coveredResult.policy.modes.already_covered).toBe('observe');
  });

  it('never loosens an observed rule', () => {
    const observing: SpendPolicy = { ...base, modes: { not_needed: 'observe', already_covered: 'observe' } };
    expect(loosen(observing, tuning, [allow(runs([0.3, 0.9]), true)])).toEqual({ policy: observing, loosenings: [] });
  });
});

describe('outcomes and the confusion matrix', () => {
  const policy: SpendPolicy = { notNeededBelow: 0.4, coveredAbove: 0.6, modes: { not_needed: 'enforce', already_covered: 'observe' } };

  it('labels each run outcome', () => {
    expect(outcome({ servesTask: 0.8, alreadyCovered: 0.1 }, policy)).toBe('pass');
    expect(outcome({ servesTask: 0.1, alreadyCovered: 0.9 }, policy)).toBe('block:not_needed');
    expect(outcome({ servesTask: 0.8, alreadyCovered: 0.9 }, policy)).toBe('flag:already_covered');
  });

  it('counts per run, rows by label', () => {
    const matrix = confusion(
      [allow(runs([0.8, 0.1], [0.3, 0.1], [0.8, 0.7])), notNeeded(runs([0.1, 0.1], [0.5, 0.1])), covered(runs([0.8, 0.9], [0.1, 0.9], [0.8, 0.2]))],
      policy,
    );
    expect(matrix.allow).toEqual({ pass: 1, 'block:not_needed': 1, 'block:already_covered': 0, 'flag:not_needed': 0, 'flag:already_covered': 1 });
    expect(matrix.not_needed).toEqual({ pass: 1, 'block:not_needed': 1, 'block:already_covered': 0, 'flag:not_needed': 0, 'flag:already_covered': 0 });
    expect(matrix.already_covered).toEqual({ pass: 1, 'block:not_needed': 1, 'block:already_covered': 0, 'flag:not_needed': 0, 'flag:already_covered': 1 });
  });

  it('falselyBlocked counts only enforced rules', () => {
    expect(falselyBlocked(allow(runs([0.8, 0.9])), policy)).toBe(false);
    expect(falselyBlocked(allow(runs([0.8, 0.1], [0.3, 0.1])), policy)).toBe(true);
    expect(falselyBlocked(notNeeded(runs([0.1, 0.1])), policy)).toBe(false);
  });
});

describe('choosePin', () => {
  const observing: SpendPolicy = { notNeededBelow: 0.1, coveredAbove: 0.95, modes: { not_needed: 'observe', already_covered: 'observe' } };
  const enforcing: SpendPolicy = { ...observing, modes: { not_needed: 'enforce', already_covered: 'observe' } };

  it('keeps the primary unless it observes everything and the fallback enforces', () => {
    expect(choosePin({ model: 'a', policy: enforcing }, { model: 'b', policy: enforcing })).toMatchObject({ model: 'a', switched: false });
    expect(choosePin({ model: 'a', policy: observing }, { model: 'b', policy: observing })).toMatchObject({ model: 'a', switched: false });
    expect(choosePin({ model: 'a', policy: observing }, { model: 'b', policy: enforcing })).toMatchObject({ model: 'b', policy: enforcing, switched: true });
    expect(choosePin({ model: 'a', policy: observing }, undefined)).toMatchObject({ model: 'a', switched: false });
  });
});
