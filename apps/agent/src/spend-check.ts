/**
 * The decision layer's SDK-agnostic core: types, constants, the Jev
 * state builder, the policy, the payer-owned deadline and the start-up line. Implementations of
 * `SpendCheck` live elsewhere; this module never imports the TypeSafe SDK.
 */
import { performance } from 'node:perf_hooks';

/** The two rules of the policy (design spec §5.1). */
export type SpendRule = 'not_needed' | 'already_covered';

/** What the checker sees of one proposed call (design spec §4.1). The model's `reason` is never part of it. */
export interface SpendCheckInput {
  task: string;
  call: { serviceName: string; serviceDescription: string; params: Record<string, string | number> };
  earlier: { serviceName: string; params: Record<string, string | number>; resultExcerpt: string }[];
}

/** The two Noul probabilities and the model that answered (design spec §4.6). */
export interface SpendCheckResult {
  model: string;
  /** Noul probability, 0..1. */
  servesTask: number;
  /** Noul probability, 0..1. */
  alreadyCovered: number;
}

/** A second opinion on a proposed paid call. */
export interface SpendCheck {
  /** The model id shown in the start-up line and the report. */
  readonly model: string;
  check(input: SpendCheckInput, signal: AbortSignal): Promise<SpendCheckResult>;
}

export type RuleMode = 'enforce' | 'observe';

export interface SpendPolicy {
  notNeededBelow: number;
  coveredAbove: number;
  modes: Record<SpendRule, RuleMode>;
}

/** The check attached to `decided` and `refused` events (design spec §6). */
export type SpendCheckSummary =
  | { status: 'passed'; model: string; servesTask: number; alreadyCovered: number; latencyMs: number }
  | { status: 'blocked'; model: string; servesTask: number; alreadyCovered: number; latencyMs: number; repeatOf?: string }
  | { status: 'flagged'; model: string; servesTask: number; alreadyCovered: number; latencyMs: number; wouldRefuse: SpendRule }
  | { status: 'unavailable'; note: string; latencyMs: number };

export type BlockedCheck = Extract<SpendCheckSummary, { status: 'blocked' }>;
/** The check on a `decided` event: passed, flagged or unavailable. */
export type DecidedCheck = Exclude<SpendCheckSummary, { status: 'blocked' }>;

/** The report's decision-layer field (design spec §6). */
export interface DecisionLayerReport {
  model: string;
  modes: Record<SpendRule, RuleMode>;
  passed: number;
  blocked: number;
  flagged: number;
  unavailable: number;
}

/** The pinned Jev model (design spec §4.3), confirmed by the evaluation (§7). */
export const JEV_MODEL = 'jev-1.14.0';
/** The payer's bound on one check (design spec §4.2). */
export const CHECK_DEADLINE_MS = 4000;

/**
 * Set by the evaluation procedure (design spec §7.3), never by hand: the recorded `--holdout` run of
 * 2026-10-16 on jev-1.14.0 (questions SHA-256 d3cd4fab…), with no hold-out loosening.
 */
export const NOT_NEEDED_BELOW = 0.5;
export const COVERED_ABOVE = 0.5;
export const NOT_NEEDED_MODE: RuleMode = 'enforce';
export const COVERED_MODE: RuleMode = 'enforce';

export const DEFAULT_SPEND_POLICY: SpendPolicy = Object.freeze({
  notNeededBelow: NOT_NEEDED_BELOW,
  coveredAbove: COVERED_ABOVE,
  modes: Object.freeze({ not_needed: NOT_NEEDED_MODE, already_covered: COVERED_MODE }) as Record<SpendRule, RuleMode>,
}) as SpendPolicy;

/** Inclusive allowed threshold ranges (design spec §5.1). */
export const ALLOWED_RANGES: Readonly<Record<SpendRule, readonly [number, number]>> = {
  not_needed: [0.1, 0.5],
  already_covered: [0.5, 0.95],
};
/** The eval's margin (design spec §7.3). */
export const MARGIN = 0.05;

export const EARLIER_MAX = 8;
export const EXCERPT_CHARS = 600;
export const PARAM_CHARS = 600;
export const TASK_CHARS = 2000;
export const STATE_MAX_CHARS = 16_000;

/** Rejection reason that carries a fail-open note (design spec §5.2). */
export class SpendCheckError extends Error {
  override readonly name = 'SpendCheckError';
  readonly note: string;
  constructor(note: string) {
    super(note);
    this.note = note;
  }
}

/** Cuts `text` to `max` characters: the first `max - 1` followed by "…". */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An earlier result's excerpt: compact JSON cut at 600 characters without a marker, or `''` with no data. */
export function resultExcerpt(data: unknown): string {
  if (data === undefined) return '';
  return (JSON.stringify(data) ?? '').slice(0, EXCERPT_CHARS);
}

/** A type alias, not an interface, so it is assignable to JSON index-signature types. */
export type SpendCheckState = {
  task: string;
  proposed_call: { service: string; description: string; params: Record<string, string | number> };
  earlier_results: { service: string; params: Record<string, string | number>; result_excerpt: string }[];
};

function cutParams(params: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) out[name] = typeof value === 'string' ? cut(value, PARAM_CHARS) : value;
  return out;
}

/** The Jev state (design spec §4.4), with its bounds applied. The input is never mutated. */
export function buildSpendCheckState(input: SpendCheckInput): SpendCheckState {
  const state: SpendCheckState = {
    task: cut(input.task, TASK_CHARS),
    proposed_call: {
      service: input.call.serviceName,
      description: input.call.serviceDescription,
      params: cutParams(input.call.params),
    },
    earlier_results: input.earlier.map((e) => ({
      service: e.serviceName,
      params: cutParams(e.params),
      result_excerpt: e.resultExcerpt.slice(0, EXCERPT_CHARS),
    })),
  };
  while (state.earlier_results.length > 0 && JSON.stringify(state).length > STATE_MAX_CHARS) {
    state.earlier_results.shift();
  }
  return state;
}

export type PolicyOutcome = { outcome: 'pass' } | { outcome: 'block'; rule: SpendRule } | { outcome: 'flag'; rule: SpendRule };

const RULE_ORDER: readonly SpendRule[] = ['not_needed', 'already_covered'];

/** Whether `rule` matches the result at the policy's threshold, whatever its mode. */
export function ruleMatches(rule: SpendRule, result: { servesTask: number; alreadyCovered: number }, policy: SpendPolicy): boolean {
  return rule === 'not_needed' ? result.servesTask < policy.notNeededBelow : result.alreadyCovered > policy.coveredAbove;
}

/** The decision (design spec §5.1): enforced matches block, then observed matches flag, `not_needed` first. */
export function applySpendPolicy(result: { servesTask: number; alreadyCovered: number }, policy: SpendPolicy): PolicyOutcome {
  const matching = RULE_ORDER.filter((rule) => ruleMatches(rule, result, policy));
  const enforced = matching.find((rule) => policy.modes[rule] === 'enforce');
  if (enforced !== undefined) return { outcome: 'block', rule: enforced };
  const observed = matching.find((rule) => policy.modes[rule] === 'observe');
  if (observed !== undefined) return { outcome: 'flag', rule: observed };
  return { outcome: 'pass' };
}

export type JudgeOutcome = { ok: true; result: SpendCheckResult; latencyMs: number } | { ok: false; note: string; latencyMs: number };

const DEADLINE = Symbol('deadline');

const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Calls a checker under the payer's deadline (design spec §4.2). Never rejects. A late settlement
 * is ignored, and its rejection is caught.
 */
export async function judgeSpendCheck(checker: SpendCheck, input: SpendCheckInput, deadlineMs: number): Promise<JudgeOutcome> {
  const start = performance.now();
  const signal = AbortSignal.timeout(deadlineMs);
  const latency = () => Math.round(performance.now() - start);
  // The deadline listener is registered before the checker sees the signal, so it settles the race
  // first even when the checker rejects on abort.
  const deadline = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(DEADLINE);
    else signal.addEventListener('abort', () => reject(DEADLINE), { once: true });
  });
  deadline.catch(() => undefined);
  let pending: Promise<SpendCheckResult>;
  try {
    pending = Promise.resolve(checker.check(input, signal));
  } catch (err) {
    pending = Promise.reject(err);
  }
  pending.catch(() => undefined);
  try {
    const result: unknown = await Promise.race([pending, deadline]);
    const latencyMs = latency();
    const r = result as Partial<SpendCheckResult> | null | undefined;
    if (
      r === null ||
      typeof r !== 'object' ||
      typeof r.model !== 'string' ||
      r.model === '' ||
      !isProbability(r.servesTask) ||
      !isProbability(r.alreadyCovered)
    ) {
      return { ok: false, note: 'unexpected error', latencyMs };
    }
    return { ok: true, result: { model: r.model, servesTask: r.servesTask, alreadyCovered: r.alreadyCovered }, latencyMs };
  } catch (err) {
    const latencyMs = latency();
    if (err === DEADLINE) return { ok: false, note: 'timed out', latencyMs };
    if (err instanceof SpendCheckError) return { ok: false, note: err.note, latencyMs };
    return { ok: false, note: 'unexpected error', latencyMs };
  }
}

export type DecisionLayerState = { on: true; model: string; policy: SpendPolicy } | { on: false; reason: string };

/** The start-up line (design spec §2). */
export function describeDecisionLayer(state: DecisionLayerState): string {
  if (!state.on) return `Decision layer: off (${state.reason})`;
  const observing = RULE_ORDER.filter((rule) => state.policy.modes[rule] === 'observe');
  return `Decision layer: Jev (${state.model}) on${observing.length === 0 ? '' : `, observe-only: ${observing.join(', ')}`}`;
}

/** Whether the configuration asks for the layer (design spec §2). */
export type DecisionLayerWant = { want: true; apiKey: string } | { want: false; reason: '--no-spend-check' | 'no TYPESAFE_API_KEY' };

export type SpendCheckFactory = (options: { apiKey: string }) => SpendCheck;

export const CLIENT_SETUP_FAILED = 'TypeSafe client setup failed';

/**
 * Builds the checker when the configuration asks for it. A throwing factory turns the layer off
 * for the session; the run continues.
 */
export function setupDecisionLayer(want: DecisionLayerWant, factory: SpendCheckFactory): { line: string; spendCheck?: SpendCheck } {
  if (!want.want) return { line: describeDecisionLayer({ on: false, reason: want.reason }) };
  let spendCheck: SpendCheck;
  try {
    spendCheck = factory({ apiKey: want.apiKey });
  } catch {
    return { line: describeDecisionLayer({ on: false, reason: CLIENT_SETUP_FAILED }) };
  }
  return { line: describeDecisionLayer({ on: true, model: spendCheck.model, policy: DEFAULT_SPEND_POLICY }), spendCheck };
}
