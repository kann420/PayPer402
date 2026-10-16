/**
 * The evaluation's pure math (decision-layer spec §7.3): thresholds from allow runs, modes by the
 * in-range rule and the catch bar, hold-out loosening, the pin rule and the confusion matrix. The
 * script `scripts/eval-spend-check.ts` runs it; tests cover it without the network.
 */
import { ALLOWED_RANGES, MARGIN, applySpendPolicy, ruleMatches, type RuleMode, type SpendPolicy, type SpendRule } from './spend-check';

export type Label = 'allow' | SpendRule;

/** One answered check of one case on one model. */
export interface Run {
  servesTask: number;
  alreadyCovered: number;
}

export interface CaseRuns {
  id: string;
  label: Label;
  holdout: boolean;
  runs: Run[];
}

export const RULES: readonly SpendRule[] = ['not_needed', 'already_covered'];
/** Own-label tuning cases a rule must catch in all runs before it may enforce (§7.3 step 3). */
export const MIN_CAUGHT = 2;

/** Rounds down to two decimals, robust to floating-point noise (0.62 − 0.05 gives 0.57). */
export const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
/** Rounds up to two decimals, robust to floating-point noise. */
export const ceil2 = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;

const clamp = (value: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, value));
const inRange = (value: number, [low, high]: readonly [number, number]) => value >= low && value <= high;
const thresholdOf = (rule: SpendRule, policy: SpendPolicy) => (rule === 'not_needed' ? policy.notNeededBelow : policy.coveredAbove);
const withThreshold = (policy: SpendPolicy, rule: SpendRule, value: number): SpendPolicy =>
  rule === 'not_needed' ? { ...policy, notNeededBelow: value } : { ...policy, coveredAbove: value };

/** A rule matches a run when its condition holds at the policy's threshold, whatever its mode. */
export function matches(rule: SpendRule, run: Run, policy: SpendPolicy): boolean {
  return ruleMatches(rule, run, policy);
}

/** A block case is caught when the rule of its own label matches every run. */
export function caught(c: CaseRuns, policy: SpendPolicy): boolean {
  if (c.label === 'allow' || c.runs.length === 0) return false;
  const rule = c.label;
  return c.runs.every((run) => matches(rule, run, policy));
}

/** An allow case is falsely blocked when an enforced rule matches any run. */
export function falselyBlocked(c: CaseRuns, policy: SpendPolicy): boolean {
  return c.label === 'allow' && c.runs.some((run) => RULES.some((rule) => policy.modes[rule] === 'enforce' && matches(rule, run, policy)));
}

/** The outcome label of one run: pass, block:<rule> or flag:<rule>. */
export function outcome(run: Run, policy: SpendPolicy): Outcome {
  const decision = applySpendPolicy(run, policy);
  return decision.outcome === 'pass' ? 'pass' : `${decision.outcome}:${decision.rule}`;
}

export type Outcome = 'pass' | `block:${SpendRule}` | `flag:${SpendRule}`;
export const OUTCOMES: readonly Outcome[] = ['pass', 'block:not_needed', 'block:already_covered', 'flag:not_needed', 'flag:already_covered'];
export const LABELS: readonly Label[] = ['allow', 'not_needed', 'already_covered'];

export type Confusion = Record<Label, Record<Outcome, number>>;

/** Rows are labels, columns are outcomes, counted per run. */
export function confusion(cases: readonly CaseRuns[], policy: SpendPolicy): Confusion {
  const empty = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const matrix: Confusion = { allow: empty(), not_needed: empty(), already_covered: empty() };
  for (const c of cases) for (const run of c.runs) matrix[c.label][outcome(run, policy)] += 1;
  return matrix;
}

/** Own-label tuning cases caught in all runs, per rule. */
export function catchCounts(tuning: readonly CaseRuns[], policy: SpendPolicy): Record<SpendRule, number> {
  return {
    not_needed: tuning.filter((c) => c.label === 'not_needed' && caught(c, policy)).length,
    already_covered: tuning.filter((c) => c.label === 'already_covered' && caught(c, policy)).length,
  };
}

/** Step 3: a rule enforces when its computed threshold is in range and it catches at least 2 own-label cases. */
function modeFor(rule: SpendRule, computed: number, stored: SpendPolicy, tuning: readonly CaseRuns[]): RuleMode {
  return inRange(computed, ALLOWED_RANGES[rule]) && catchCounts(tuning, stored)[rule] >= MIN_CAUGHT ? 'enforce' : 'observe';
}

export interface ComputedPolicy {
  policy: SpendPolicy;
  minAllowServes: number;
  maxAllowCovered: number;
  /** `floor2(minAllowServes − 0.05)` and `ceil2(maxAllowCovered + 0.05)`, before the 0.50 cap or floor. */
  raw: Record<SpendRule, number>;
  /** After the 0.50 cap (`not_needed`) or floor (`already_covered`), before clamping into the range. */
  computed: Record<SpendRule, number>;
  inRange: Record<SpendRule, boolean>;
  caught: Record<SpendRule, number>;
}

/** Steps 2 and 3 on the tuning runs. */
export function computePolicy(tuning: readonly CaseRuns[]): ComputedPolicy {
  const allowRuns = tuning.filter((c) => c.label === 'allow').flatMap((c) => c.runs);
  if (allowRuns.length === 0) throw new Error('computePolicy needs at least one allow run');
  const minAllowServes = Math.min(...allowRuns.map((r) => r.servesTask));
  const maxAllowCovered = Math.max(...allowRuns.map((r) => r.alreadyCovered));
  const raw = { not_needed: floor2(minAllowServes - MARGIN), already_covered: ceil2(maxAllowCovered + MARGIN) };
  const computed = { not_needed: Math.min(0.5, raw.not_needed), already_covered: Math.max(0.5, raw.already_covered) };
  const stored: SpendPolicy = {
    notNeededBelow: clamp(computed.not_needed, ALLOWED_RANGES.not_needed),
    coveredAbove: clamp(computed.already_covered, ALLOWED_RANGES.already_covered),
    modes: { not_needed: 'observe', already_covered: 'observe' },
  };
  const policy: SpendPolicy = {
    ...stored,
    modes: {
      not_needed: modeFor('not_needed', computed.not_needed, stored, tuning),
      already_covered: modeFor('already_covered', computed.already_covered, stored, tuning),
    },
  };
  return {
    policy,
    minAllowServes,
    maxAllowCovered,
    raw,
    computed,
    inRange: { not_needed: inRange(computed.not_needed, ALLOWED_RANGES.not_needed), already_covered: inRange(computed.already_covered, ALLOWED_RANGES.already_covered) },
    caught: catchCounts(tuning, stored),
  };
}

export interface Loosening {
  rule: SpendRule;
  caseIds: string[];
  /** The worst matching hold-out allow value. */
  value: number;
  from: number;
  to: number;
  mode: RuleMode;
}

/**
 * Step 4's one exception: while an enforced rule falsely blocks a hold-out allow run, move its
 * threshold just past the worst such value, clamp it, and re-apply step 3 on the tuning runs.
 */
export function loosen(policy: SpendPolicy, tuning: readonly CaseRuns[], holdout: readonly CaseRuns[]): { policy: SpendPolicy; loosenings: Loosening[] } {
  let current: SpendPolicy = { ...policy, modes: { ...policy.modes } };
  const loosenings: Loosening[] = [];
  const allow = holdout.filter((c) => c.label === 'allow');
  for (;;) {
    let changed = false;
    for (const rule of RULES) {
      if (current.modes[rule] !== 'enforce') continue;
      const hits = allow.flatMap((c) => c.runs.filter((run) => matches(rule, run, current)).map((run) => ({ id: c.id, run })));
      if (hits.length === 0) continue;
      const values = hits.map((h) => (rule === 'not_needed' ? h.run.servesTask : h.run.alreadyCovered));
      const value = rule === 'not_needed' ? Math.min(...values) : Math.max(...values);
      const computed = rule === 'not_needed' ? floor2(value - MARGIN) : ceil2(value + MARGIN);
      const stored = withThreshold(current, rule, clamp(computed, ALLOWED_RANGES[rule]));
      const mode = modeFor(rule, computed, stored, tuning);
      loosenings.push({ rule, caseIds: [...new Set(hits.map((h) => h.id))], value, from: thresholdOf(rule, current), to: thresholdOf(rule, stored), mode });
      current = { ...stored, modes: { ...stored.modes, [rule]: mode } };
      changed = true;
    }
    if (!changed) return { policy: current, loosenings };
  }
}

export interface PinChoice {
  model: string;
  policy: SpendPolicy;
  switched: boolean;
  reason: string;
}

/**
 * Step 5: the pin stays on the primary model unless it ends with both rules observing and the
 * fallback enforces at least one.
 */
export function choosePin(primary: { model: string; policy: SpendPolicy }, fallback: { model: string; policy: SpendPolicy } | undefined): PinChoice {
  const enforces = (p: SpendPolicy) => RULES.some((rule) => p.modes[rule] === 'enforce');
  if (!enforces(primary.policy) && fallback !== undefined && enforces(fallback.policy)) {
    return {
      model: fallback.model,
      policy: fallback.policy,
      switched: true,
      reason: `${primary.model} ends with both rules observing and ${fallback.model} enforces at least one`,
    };
  }
  return {
    model: primary.model,
    policy: primary.policy,
    switched: false,
    reason: enforces(primary.policy)
      ? `${primary.model} enforces at least one rule`
      : `${primary.model} ends with both rules observing, and ${fallback?.model ?? 'no fallback'} enforces none either`,
  };
}
