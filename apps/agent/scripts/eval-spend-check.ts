/**
 * Decision-layer evaluation: runs the labelled cases against the
 * real Jev through the shipped code (createJevSpendCheck, judgeSpendCheck with the production
 * deadline, applySpendPolicy), then computes thresholds and modes by the fixed procedure.
 *
 *   npm run eval:spend-check -w apps/agent [-- --holdout] [--models jev-1.14.0,jev-1.13.0] [--repeats 3]
 *
 * Without --holdout only the tuning cases are loaded and sent. --holdout is the recorded run: it
 * also scores the hold-out cases once, applies the loosening rule and decides the pin. Needs
 * TYPESAFE_API_KEY (root .env); the key is never printed.
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { VERSION, type Fetch } from '@typesafe-ai/sdk';
import { env } from '../src/config';
import {
  LABELS,
  OUTCOMES,
  RULES,
  caught,
  choosePin,
  computePolicy,
  confusion,
  falselyBlocked,
  loosen,
  outcome,
  type CaseRuns,
  type Run,
} from '../src/eval-policy';
import { JEV_QUESTIONS, createJevSpendCheck } from '../src/jev';
import { CHECK_DEADLINE_MS, judgeSpendCheck, type SpendCheck, type SpendPolicy } from '../src/spend-check';
import { CASES, caseInput, type EvalCase } from './spend-check-cases';

export const DEFAULT_MODELS = ['jev-1.14.0', 'jev-1.13.0'];
export const DEFAULT_REPEATS = 3;
/** Extra attempts per case and model when a check comes back unavailable (§7.1). */
export const EXTRA_ATTEMPTS = 3;
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export interface EvalDeps {
  /** Builds the checker for one model; `fetch` must be passed to the client so tokens can be counted. */
  createChecker(model: string, fetch: Fetch): SpendCheck;
  out(line: string): void;
  /** The cases; defaults to the labelled set. */
  cases?: readonly EvalCase[];
  fetch?: Fetch;
}

interface ModelRun {
  model: string;
  cases: CaseRuns[];
  latencies: number[];
  retried: number;
  incomplete: string[];
  tokens: number;
  nullTokens: number;
  answeredBodies: number;
}

const f2 = (x: number) => x.toFixed(2);
const range = (values: number[]) => (values.length === 0 ? '-' : `${f2(Math.min(...values))}-${f2(Math.max(...values))}`);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

const describePolicy = (p: SpendPolicy) =>
  `not_needed < ${f2(p.notNeededBelow)} (${p.modes.not_needed}), already_covered > ${f2(p.coveredAbove)} (${p.modes.already_covered})`;

/** A fetch that reads `usage.input_tokens` from each 200 body before handing the response on. */
function countingFetch(base: Fetch, stats: { tokens: number; nullTokens: number; answeredBodies: number }): Fetch {
  return async (url, init) => {
    const res = await base(url, init);
    if (res.status === 200) {
      const body = (await res
        .clone()
        .json()
        .catch(() => undefined)) as { usage?: { input_tokens?: number | null } } | undefined;
      const tokens = body?.usage?.input_tokens;
      stats.answeredBodies += 1;
      if (typeof tokens === 'number') stats.tokens += tokens;
      else stats.nullTokens += 1;
    }
    return res;
  };
}

async function runModel(model: string, cases: readonly EvalCase[], repeats: number, deps: EvalDeps): Promise<ModelRun> {
  const stats = { tokens: 0, nullTokens: 0, answeredBodies: 0 };
  const checker = deps.createChecker(model, countingFetch(deps.fetch ?? fetch, stats));
  const result: ModelRun = { model, cases: [], latencies: [], retried: 0, incomplete: [], tokens: 0, nullTokens: 0, answeredBodies: 0 };
  for (const c of cases) {
    const input = caseInput(c);
    const runs: Run[] = [];
    let attempts = 0;
    while (runs.length < repeats && attempts < repeats + EXTRA_ATTEMPTS) {
      attempts += 1;
      const judged = await judgeSpendCheck(checker, input, CHECK_DEADLINE_MS);
      result.latencies.push(judged.latencyMs);
      if (judged.ok) runs.push({ servesTask: judged.result.servesTask, alreadyCovered: judged.result.alreadyCovered });
      else deps.out(`   [${model}] ${c.id}: attempt ${attempts} unavailable (${judged.note})`);
    }
    result.retried += Math.max(0, attempts - repeats);
    if (runs.length < repeats) result.incomplete.push(c.id);
    result.cases.push({ id: c.id, label: c.label, holdout: c.holdout, runs });
  }
  Object.assign(result, stats);
  return result;
}

function caseLine(c: CaseRuns, policy: SpendPolicy): string {
  const ok = c.label === 'allow' ? !falselyBlocked(c, policy) : caught(c, policy);
  const outcomes = c.runs.map((run) => outcome(run, policy)).join(',');
  return `  ${ok ? '✓' : '✗'} ${c.id.padEnd(40)} ${c.label.padEnd(15)} serves ${range(c.runs.map((r) => r.servesTask))}  covered ${range(
    c.runs.map((r) => r.alreadyCovered),
  )}  ${outcomes}`;
}

function matrixLines(title: string, cases: readonly CaseRuns[], policy: SpendPolicy): string[] {
  const m = confusion(cases, policy);
  const head = `  ${title.padEnd(16)}${OUTCOMES.map((o) => o.padStart(22)).join('')}`;
  return [head, ...LABELS.map((label) => `  ${label.padEnd(16)}${OUTCOMES.map((o) => String(m[label][o]).padStart(22)).join('')}`)];
}

function holdoutCatchRate(holdout: readonly CaseRuns[], policy: SpendPolicy): string {
  return RULES.map((rule) => {
    const own = holdout.filter((c) => c.label === rule);
    return `${rule} ${own.filter((c) => caught(c, policy)).length}/${own.length}`;
  }).join(', ');
}

/** Runs the evaluation. Returns the exit code: 0 when complete. */
export async function runEval(argv: string[], deps: EvalDeps): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { holdout: { type: 'boolean' }, models: { type: 'string' }, repeats: { type: 'string' } },
    strict: true,
  });
  const withHoldout = values.holdout === true;
  const models = (values.models ?? DEFAULT_MODELS.join(','))
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');
  const repeats = Number(values.repeats ?? DEFAULT_REPEATS);
  if (models.length === 0 || !Number.isInteger(repeats) || repeats < 1) {
    deps.out('Invalid --models or --repeats.');
    return 2;
  }
  // Hold-out cases are filtered out before any request unless --holdout is given.
  const cases = (deps.cases ?? CASES).filter((c) => withHoldout || !c.holdout);
  const out = deps.out;
  const wordingHash = createHash('sha256').update(JSON.stringify(JEV_QUESTIONS)).digest('hex');

  out(`Decision-layer evaluation (${withHoldout ? '--holdout: recorded run' : 'tuning cases only'})`);
  out(`Date: ${new Date().toISOString()}   @typesafe-ai/sdk ${VERSION}`);
  out(`Models: ${models.join(', ')}   Repeats: ${repeats}   Deadline: ${CHECK_DEADLINE_MS} ms`);
  out(`Questions SHA-256: ${wordingHash}`);
  out(
    `Cases: ${cases.filter((c) => !c.holdout).length} tuning${withHoldout ? `, ${cases.filter((c) => c.holdout).length} hold-out` : ''} ` +
      `(${LABELS.map((l) => `${l} ${cases.filter((c) => c.label === l).length}`).join(', ')})`,
  );
  out('Numbers are indicative only: the case set is small.');

  const results: ModelRun[] = [];
  for (const model of models) results.push(await runModel(model, cases, repeats, deps));

  const incomplete = results.filter((r) => r.incomplete.length > 0);
  for (const r of results) out(`[${r.model}] retried attempts: ${r.retried}`);
  if (incomplete.length > 0) {
    out('INCOMPLETE');
    for (const r of incomplete) out(`  ${r.model}: ${r.incomplete.join(', ')}`);
    out('Nothing is recorded from this run.');
    return 1;
  }

  const finals: { model: string; policy: SpendPolicy }[] = [];
  for (const r of results) {
    const tuning = r.cases.filter((c) => !c.holdout);
    const holdout = r.cases.filter((c) => c.holdout);
    const computed = computePolicy(tuning);
    out('');
    out(`=== ${r.model}`);
    out(`Tuning cases at the computed policy (${describePolicy(computed.policy)}):`);
    for (const c of tuning) out(caseLine(c, computed.policy));
    out(`minAllowServes ${computed.minAllowServes.toFixed(3)}   maxAllowCovered ${computed.maxAllowCovered.toFixed(3)}`);
    for (const rule of RULES) {
      out(
        `  ${rule.padEnd(16)} raw ${f2(computed.raw[rule])}  computed ${f2(computed.computed[rule])}  ` +
          `stored ${f2(rule === 'not_needed' ? computed.policy.notNeededBelow : computed.policy.coveredAbove)}  ` +
          `in range ${computed.inRange[rule] ? 'yes' : 'no'}  caught ${computed.caught[rule]}/${tuning.filter((c) => c.label === rule).length}  ` +
          `mode ${computed.policy.modes[rule]}`,
      );
    }
    for (const line of matrixLines('tuning', tuning, computed.policy)) out(line);
    let final = computed.policy;
    if (withHoldout) {
      out(`Hold-out cases at the frozen policy:`);
      for (const c of holdout) out(caseLine(c, computed.policy));
      for (const line of matrixLines('hold-out', holdout, computed.policy)) out(line);
      const loosened = loosen(computed.policy, tuning, holdout);
      if (loosened.loosenings.length === 0) out('Loosening: none (no hold-out allow run falsely blocked).');
      for (const l of loosened.loosenings) {
        out(`Loosening: ${l.rule} ${f2(l.from)} -> ${f2(l.to)} past ${l.value.toFixed(3)} (${l.caseIds.join(', ')}), mode ${l.mode}`);
      }
      final = loosened.policy;
      if (loosened.loosenings.length > 0) {
        out(`Hold-out cases at the final policy:`);
        for (const c of holdout) out(caseLine(c, final));
        for (const line of matrixLines('hold-out', holdout, final)) out(line);
      }
      out(`Hold-out catch rate at the final policy: ${holdoutCatchRate(holdout, final)}`);
      out(`Final policy: ${describePolicy(final)}`);
    }
    finals.push({ model: r.model, policy: final });
    out(`Latency: median ${percentile(r.latencies, 50)} ms, p95 ${percentile(r.latencies, 95)} ms (${r.latencies.length} attempts)`);
    out(
      `Tokens: ${r.tokens} input over ${r.answeredBodies - r.nullTokens} answers (${r.nullTokens} without a count), about $${(r.tokens * USD_PER_INPUT_TOKEN).toFixed(5)}`,
    );
  }

  if (withHoldout) {
    const [primary, fallback] = finals;
    if (primary !== undefined) {
      const pin = choosePin(primary, fallback);
      out('');
      out(`Pin: ${pin.model}${pin.switched ? ' (switched)' : ''}. ${pin.reason}.`);
      out(`Pinned policy: ${describePolicy(pin.policy)}`);
    }
  }
  return 0;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('/scripts/eval-spend-check.ts')) {
  const apiKey = env(process.env, 'TYPESAFE_API_KEY');
  if (apiKey === undefined) {
    process.stderr.write('TYPESAFE_API_KEY is required (root .env).\n');
    process.exitCode = 1;
  } else {
    runEval(process.argv.slice(2), {
      createChecker: (model, fetch) => createJevSpendCheck({ apiKey, model, fetch }),
      out: (line) => process.stdout.write(`${line}\n`),
    })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err: unknown) => {
        process.stderr.write(`The evaluation failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
        process.exitCode = 1;
      });
  }
}
