/** `POST /api/ai/turn?scope=operator|seller` (design spec §12.3). */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { AgLlmRequest } from 'ag-studio';
import { BUSY_MESSAGE, failedResponse, runTurn, TurnCache, turnRequestSchema } from '../ai-turn';
import { isWebConfigError } from '../config';
import { sessionKey, type WebDeps } from '../deps';
import { SlidingWindow } from '../limits';
import { checkOrigin, isRouteError, requireScope } from './common';

export const AI_BODY_LIMIT = 256 * 1024;

export interface AiDeps {
  client: () => Anthropic;
  cache: TurnCache;
}

const GLOBAL = globalThis as unknown as { __pp402TurnCache?: TurnCache; __pp402AiClient?: Anthropic };

export function realAiDeps(): AiDeps {
  GLOBAL.__pp402TurnCache ??= new TurnCache();
  return {
    cache: GLOBAL.__pp402TurnCache,
    client: () => {
      GLOBAL.__pp402AiClient ??= new Anthropic();
      return GLOBAL.__pp402AiClient;
    },
  };
}

const failure = (status: number, code: string, message: string) => Response.json(failedResponse(code, message), { status, headers: { 'Cache-Control': 'no-store' } });

export function createAiTurnHandler(deps: WebDeps, ai: AiDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      checkOrigin(request, deps.config.publicOrigin);
      const { session } = requireScope(request, sessionKey(deps));
      const declared = Number(request.headers.get('content-length') ?? '0');
      const text = Number.isFinite(declared) && declared > AI_BODY_LIMIT ? undefined : await request.text();
      if (text === undefined || Buffer.byteLength(text, 'utf8') > AI_BODY_LIMIT) return failure(413, 'payload_too_large', 'The conversation is too long.');
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return failure(400, 'bad_request', 'The body must be JSON.');
      }
      if (!turnRequestSchema.safeParse(value).success) return failure(400, 'bad_request', 'The conversation is malformed.');
      // The checked shape is the subset of AG Studio's request that the translation reads.
      const body = value as AgLlmRequest;
      const limits = deps.limits;
      if (!SlidingWindow.take([[limits.aiPerSession, session.sid], [limits.aiAll, 'all']])) return failure(429, 'ai_limit', BUSY_MESSAGE);
      const result = await runTurn({
        request: body,
        client: ai.client(),
        cache: ai.cache,
        sid: session.sid,
        model: deps.config.model,
        signal: request.signal,
        log: deps.log,
      });
      return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (isRouteError(error)) return failure(error.status, error.code, error.message);
      if (isWebConfigError(error)) return failure(503, 'not_configured', 'The assistant is not configured.');
      deps.log(`[ai/turn] unexpected error: ${error instanceof Error ? error.name : 'unknown'}`);
      return failure(500, 'internal_error', 'The assistant could not answer. Try again in a moment.');
    }
  };
}
