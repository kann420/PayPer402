/**
 * The Jev implementation of `SpendCheck` (decision-layer spec §4.3–§4.6), over `@typesafe-ai/sdk`.
 * This is the only `src/` module that imports the SDK.
 */
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, TypeSafeClient, noul, type Fetch } from '@typesafe-ai/sdk';
import { CHECK_DEADLINE_MS, JEV_MODEL, SpendCheckError, buildSpendCheckState, type SpendCheck, type SpendCheckResult } from './spend-check';

/** The two questions (design spec §4.5), answered in parallel in one request. */
export const JEV_QUESTIONS = {
  serves_task: noul('Does `proposed_call`, with its `params`, return information that the `task` asks for?', {
    true: 'The task asks for the information this call would return, given the service description and these params. A call that answers one part of a task with several parts counts.',
    false: 'The task does not ask for the information this call would return with these params.',
  }),
  already_covered: noul('Do the `earlier_results` already contain the result that `proposed_call` would return?', {
    true: 'An earlier result already holds the same information in the same language and form, so the call would repeat it.',
    false:
      'No earlier result holds it, or the call would produce a new form of it, such as a translation into a language not yet present or a summary of a page not yet summarized, or there are no earlier results.',
  }),
};

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/** The fail-open note for an SDK error (design spec §5.2). The order matters: a timeout is a connection error. */
export function unavailableNote(err: unknown): string {
  if (err instanceof APITimeoutError) return 'timed out';
  if (err instanceof APIUserAbortError) return 'timed out';
  if (err instanceof APIError) return `service error (HTTP ${err.status})`;
  if (err instanceof APIConnectionError) return 'connection failed';
  return 'unexpected error';
}

export interface JevSpendCheckOptions {
  /** Trimmed, from the agent config. Never logged. */
  apiKey: string;
  /** For tests and the evaluation. */
  fetch?: Fetch;
  /** For the evaluation and tests only; the CLI and the demo never set it. */
  model?: string;
}

const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function noulOf(answer: unknown): number | undefined {
  if (answer === null || typeof answer !== 'object') return undefined;
  const { type, noul: value } = answer as { type?: unknown; noul?: unknown };
  return type === 'noul' && isProbability(value) ? value : undefined;
}

/**
 * A Jev checker. Every option with an environment fallback is set explicitly, so the SDK's
 * environment variables have no effect. Throws when the key is missing or invalid (spike O2).
 */
export function createJevSpendCheck({ apiKey, fetch, model = JEV_MODEL }: JevSpendCheckOptions): SpendCheck {
  const client = new TypeSafeClient({
    apiKey,
    baseURL: TYPESAFE_BASE_URL,
    logLevel: 'off',
    timeout: CHECK_DEADLINE_MS,
    retry: { maxRetries: 0 },
    compression: false,
    ...(fetch === undefined ? {} : { fetch }),
  });
  return {
    model,
    async check(input, signal): Promise<SpendCheckResult> {
      let response;
      try {
        response = await client.systemOne({ model, state: buildSpendCheckState(input), questions: JEV_QUESTIONS }, { signal });
      } catch (err) {
        throw new SpendCheckError(unavailableNote(err));
      }
      const answers = (response as { answers?: unknown }).answers as Record<string, unknown> | undefined;
      const servesTask = noulOf(answers?.['serves_task']);
      const alreadyCovered = noulOf(answers?.['already_covered']);
      if (servesTask === undefined || alreadyCovered === undefined) throw new SpendCheckError('unexpected error');
      return { model: response.model, servesTask, alreadyCovered };
    },
  };
}
