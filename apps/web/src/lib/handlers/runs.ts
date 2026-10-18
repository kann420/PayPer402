/** `POST /api/runs` (design spec §14): one agent run, streamed as SSE. */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import {
  createJevSpendCheck,
  decisionLayerWant,
  openSession,
  runAgent,
  setupDecisionLayer,
  type AgentEvent,
  type AgentRunResult,
  type OpenSessionOptions,
  type RunAgentOptions,
} from '@payper402/agent';
import { importPrivateKeyRaw, priceToCents } from '@payper402/scheme-paypal';
import { z } from 'zod';
import { isNamedError } from '../brand';
import { sessionKey, type WebDeps } from '../deps';
import { isFacilitatorError } from '../facilitator';
import { SlidingWindow } from '../limits';
import { agentSeed } from '../session';
import { encodeFrame, KEEPALIVE, RUN_KEEPALIVE_MS, RUN_TIME_LIMIT_MS, RunRegistry, runSignal } from '../runs';
import { checkOrigin, errorResponse, readBody, requireOperator, RouteError } from './common';

export const RUN_LIMIT_MESSAGE = 'Too many agent runs right now. Try again later.';

const bodySchema = z.strictObject({
  agentId: z.string().min(1).max(100),
  task: z.string().trim().min(1).max(500),
  budget: z.string().min(1).max(20),
});

export interface RunDeps {
  registry: RunRegistry;
  anthropic: () => Anthropic;
  runAgent: (options: RunAgentOptions) => Promise<AgentRunResult>;
  openSession: (options: OpenSessionOptions) => ReturnType<typeof openSession>;
  /** The session `fetch` (paid calls and the catalog); defaults to the global one. */
  sessionFetch?: typeof fetch;
  limitMs?: number;
  keepaliveMs?: number;
}

const GLOBAL = globalThis as unknown as { __pp402Runs?: RunRegistry; __pp402Anthropic?: Anthropic };

/** The real run dependencies: one registry and one Anthropic client per process. */
export function realRunDeps(): RunDeps {
  GLOBAL.__pp402Runs ??= new RunRegistry();
  return {
    registry: GLOBAL.__pp402Runs,
    anthropic: () => {
      GLOBAL.__pp402Anthropic ??= new Anthropic();
      return GLOBAL.__pp402Anthropic;
    },
    runAgent,
    openSession,
  };
}

/** Budget dollars to cents, between 1 and 500 (design spec §14.1). */
export function parseBudget(budget: string): number | undefined {
  try {
    const cents = priceToCents(budget.trim());
    return cents >= 1 && cents <= 500 ? cents : undefined;
  } catch {
    return undefined;
  }
}

function startReason(error: unknown): string {
  if (isNamedError(error, 'CatalogError')) return error.message;
  if (isFacilitatorError(error)) return error.code === 'session_ended' ? 'your demo session ended' : 'PayPer402 could not be reached';
  return 'an unexpected error';
}

export function createRunsHandler(deps: WebDeps, run: RunDeps) {
  return async (request: Request): Promise<Response> => {
    let operatorId: string;
    let controller: AbortController | undefined;
    try {
      checkOrigin(request, deps.config.publicOrigin);
      const session = requireOperator(request, sessionKey(deps));
      const body = await readBody(request, bodySchema);
      const budgetCents = parseBudget(body.budget);
      if (budgetCents === undefined) {
        throw new RouteError(400, 'validation_failed', 'The request is invalid.', {
          issues: [{ path: 'budget', message: 'The budget must be between $0.01 and $5.00.' }],
        });
      }
      const seed = agentSeed(session, body.agentId);
      if (seed === undefined) throw new RouteError(404, 'agent_key_missing', "This browser doesn't hold this agent's key.");
      operatorId = session.operator.id;
      if (run.registry.has(operatorId)) throw new RouteError(409, 'run_in_progress', 'A run is already in progress for this account.');
      const limits = deps.limits;
      if (!SlidingWindow.take([[limits.runsPerOperator, operatorId], [limits.runsAll, 'all']])) {
        throw new RouteError(429, 'run_limit', RUN_LIMIT_MESSAGE);
      }
      controller = run.registry.claim(operatorId);
      if (controller === undefined) throw new RouteError(409, 'run_in_progress', 'A run is already in progress for this account.');

      const own = controller;
      const operatorKey = session.operator.key;
      const { signal, dispose } = runSignal(request.signal, own, run.limitMs ?? RUN_TIME_LIMIT_MS);
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let closed = false;

      const stream = new ReadableStream<Uint8Array>({
        start: (streamController) => {
          const send = (chunk: Uint8Array) => {
            if (closed) return;
            try {
              streamController.enqueue(chunk);
            } catch {
              closed = true;
            }
          };
          const frame = (event: string, data: unknown) => send(encodeFrame(event, data));
          keepalive = setInterval(() => send(KEEPALIVE), run.keepaliveMs ?? RUN_KEEPALIVE_MS);

          void (async () => {
            try {
              const view = await deps.facilitator.operator(operatorKey).get();
              const maxPerCallCents = Math.min(view.caps.perCall, budgetCents);
              const layer = deps.config.decisionLayer
                ? setupDecisionLayer(decisionLayerWant({ TYPESAFE_API_KEY: deps.config.typesafeApiKey }, false), createJevSpendCheck)
                : undefined;
              const agentSession = await run.openSession({
                sellerUrl: deps.config.sellerUrl,
                privateKey: importPrivateKeyRaw(seed),
                budgetCents,
                maxPerCallCents,
                onEvent: (event: AgentEvent) => frame('agent', event),
                ...(run.sessionFetch === undefined ? {} : { fetch: run.sessionFetch }),
                ...(layer?.spendCheck === undefined ? {} : { spendCheck: { checker: layer.spendCheck, task: body.task } }),
              });
              frame('catalog', {
                services: agentSession.catalog.services.map((s) => ({ id: s.id, name: s.name, method: s.method, path: s.path, priceCents: s.priceCents })),
              });
              const result = await run.runAgent({ task: body.task, session: agentSession, anthropic: run.anthropic(), model: deps.config.model, signal });
              frame('end', { status: result.status });
            } catch (error) {
              deps.log(`[runs] the run could not start: ${error instanceof Error ? error.name : 'unknown'}`);
              frame('error', { message: `The agent couldn't start: ${startReason(error)}` });
            } finally {
              dispose();
              run.registry.release(operatorId, own);
              if (keepalive !== undefined) clearInterval(keepalive);
              if (!closed) {
                closed = true;
                try {
                  streamController.close();
                } catch {
                  // The browser already left.
                }
              }
            }
          })();
        },
        cancel: () => {
          closed = true;
          if (keepalive !== undefined) clearInterval(keepalive);
          own.abort(new Error('browser left'));
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
      });
    } catch (error) {
      return errorResponse(error, deps.log);
    }
  };
}
