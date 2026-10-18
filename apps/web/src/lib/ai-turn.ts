/**
 * The AI assistant's server half (design spec §12.3): one AG Studio turn in, one Claude Messages
 * call out. Ported from the spike's route and hardened: the turn cache is keyed by session, and
 * bounded per session and in total.
 */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { AgAiConversationItem, AgAiOutputItem, AgLlmRequest, AgLlmResponse } from 'ag-studio';
import { z } from 'zod';
import { normalizeToolSchema } from './tool-schema';

/**
 * The parts of an AG Studio turn this module reads, checked before translation so a malformed item
 * is a 400 `failed` answer, not a TypeError. Unknown extra fields pass through.
 */
const otherPartType = z.string().refine((t) => t !== 'text' && t !== 'refusal');
const textPart = z.looseObject({ type: z.literal('text'), text: z.string() });
const refusalPart = z.looseObject({ type: z.literal('refusal'), refusal: z.string() });
const itemId = z.string().optional();
const turnItemSchema = z.union([
  z.looseObject({
    type: z.literal('message'),
    kind: z.literal('input'),
    role: z.string(),
    content: z.array(z.union([textPart, z.looseObject({ type: otherPartType })])),
  }),
  z.looseObject({ type: z.literal('message'), kind: z.literal('output').optional(), id: itemId, content: z.array(z.union([textPart, refusalPart])) }),
  z.looseObject({ type: z.literal('function_call'), id: itemId, callId: z.string(), name: z.string(), arguments: z.string() }),
  z.looseObject({ type: z.literal('function_call_output'), id: itemId, callId: z.string(), output: z.string() }),
  z.looseObject({ type: z.literal('reasoning'), id: itemId }),
]);
export const turnRequestSchema = z.looseObject({
  input: z.array(turnItemSchema),
  instructions: z.string().optional(),
  tools: z.array(z.looseObject({ name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() })).optional(),
  toolChoice: z.unknown().optional(),
  responseFormat: z.looseObject({ type: z.string(), schema: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export const AI_BETAS = ['server-side-fallback-2026-07-01'];
export const AI_MAX_TOKENS = 16_000;
export const BUSY_MESSAGE = 'The assistant is busy. Try again in a few minutes.';

type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * Claude's full assistant turns, keyed by `<sid>:<message id>`. AG Studio keeps only the text and
 * tool calls of a turn; replaying the original blocks keeps the history append-only and the
 * thinking blocks intact. Oldest entries are evicted first.
 */
export class TurnCache {
  private readonly entries = new Map<string, ContentBlockParam[]>();
  private readonly perSid = new Map<string, string[]>();
  readonly maxPerSid: number;
  readonly maxTotal: number;

  constructor(options: { maxPerSid?: number; maxTotal?: number } = {}) {
    this.maxPerSid = options.maxPerSid ?? 50;
    this.maxTotal = options.maxTotal ?? 2000;
  }

  get size(): number {
    return this.entries.size;
  }

  get(sid: string, messageId: string): ContentBlockParam[] | undefined {
    return this.entries.get(`${sid}:${messageId}`);
  }

  remember(sid: string, messageId: string, content: ContentBlockParam[]): void {
    const key = `${sid}:${messageId}`;
    if (!this.entries.has(key)) {
      const keys = this.perSid.get(sid) ?? [];
      keys.push(key);
      this.perSid.set(sid, keys);
      if (keys.length > this.maxPerSid) this.drop(keys.shift() as string);
    }
    this.entries.set(key, content);
    while (this.entries.size > this.maxTotal) {
      const oldest = this.entries.keys().next().value as string;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    this.entries.delete(key);
    const sid = key.slice(0, key.indexOf(':'));
    const keys = this.perSid.get(sid);
    if (keys === undefined) return;
    const index = keys.indexOf(key);
    if (index >= 0) keys.splice(index, 1);
    if (keys.length === 0) this.perSid.delete(sid);
  }
}

/** Output item ids are `<claude message id>:<block index>`. */
export function claudeMessageId(itemId: string | undefined): string | undefined {
  const match = itemId === undefined ? null : /^(msg_[^:]+):\d+$/.exec(itemId);
  return match?.[1];
}

function pushBlocks(messages: MessageParam[], role: 'user' | 'assistant', blocks: ContentBlockParam[]): void {
  if (blocks.length === 0) return;
  const last = messages.at(-1);
  if (last?.role === role && Array.isArray(last.content)) {
    last.content.push(...blocks);
  } else {
    messages.push({ role, content: [...blocks] });
  }
}

/**
 * Studio seeds preflight tool calls with ids like `<runId>-preflight-0`; Claude tool ids must match
 * `^[a-zA-Z0-9_-]{1,64}$`. A call and its result map the same way.
 */
export function toolId(callId: string): string {
  const clean = callId.replace(/[^a-zA-Z0-9_-]/g, '_') || '_';
  return clean.length <= 64 ? clean : `${clean.slice(0, 40)}_${clean.length}_${clean.slice(-16)}`.slice(0, 64);
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(args === '' ? '{}' : args);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface Translated {
  system: string[];
  messages: MessageParam[];
  replayed: number;
}

/** AG Studio's conversation to Claude messages, replaying this session's cached turns. */
export function toMessages(input: AgAiConversationItem[], cache: TurnCache, sid: string): Translated {
  const system: string[] = [];
  const messages: MessageParam[] = [];
  const replayed = new Set<string>();

  for (const item of input) {
    if (item.type === 'message' && item.kind === 'input') {
      const text = item.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n');
      if (item.role === 'system') system.push(text);
      else if (text !== '') pushBlocks(messages, 'user', [{ type: 'text', text }]);
      continue;
    }
    if (item.type === 'function_call_output') {
      pushBlocks(messages, 'user', [{ type: 'tool_result', tool_use_id: toolId(item.callId), content: item.output }]);
      continue;
    }

    const msgId = claudeMessageId(item.id);
    const cached = msgId === undefined ? undefined : cache.get(sid, msgId);
    if (msgId !== undefined && cached !== undefined) {
      if (!replayed.has(msgId)) {
        replayed.add(msgId);
        pushBlocks(messages, 'assistant', structuredClone(cached));
      }
      continue;
    }
    if (item.type === 'message') {
      const text = item.content.map((c) => (c.type === 'text' ? c.text : c.refusal)).join('');
      if (text !== '') pushBlocks(messages, 'assistant', [{ type: 'text', text }]);
    } else if (item.type === 'function_call') {
      pushBlocks(messages, 'assistant', [{ type: 'tool_use', id: toolId(item.callId), name: item.name, input: parseArguments(item.arguments) }]);
    }
    // Reasoning items carry no signature, so they cannot be replayed.
  }
  return { system, messages, replayed: replayed.size };
}

export function toTools(request: AgLlmRequest): Anthropic.Beta.BetaToolUnion[] | undefined {
  if (request.tools === undefined || request.tools.length === 0 || request.toolChoice === 'none') return undefined;
  return request.tools.map((tool) => {
    const schema = (tool.parameters ?? {}) as Record<string, unknown>;
    return {
      name: tool.name,
      description: tool.description ?? '',
      // Studio's generated schemas are flattened first (design spec §12.3, "Query reliability").
      input_schema: { ...normalizeToolSchema(schema), type: 'object' } as Anthropic.Beta.BetaTool.InputSchema,
    };
  });
}

/** Forced tool choice is a 400 on current models, so it becomes a prompt line. */
export function toolChoiceNote(request: AgLlmRequest): string | undefined {
  const choice = request.toolChoice;
  if (choice === 'required') return 'Respond by calling one of the available tools.';
  if (typeof choice === 'object' && choice !== null && 'name' in choice) return `Respond by calling the ${choice.name} tool.`;
  return undefined;
}

export function toResponse(message: Anthropic.Beta.BetaMessage): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  message.content.forEach((block, index) => {
    const id = `${message.id}:${index}`;
    if (block.type === 'text' && block.text !== '') {
      output.push({ id, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: block.text, annotations: [] }] });
    } else if (block.type === 'tool_use') {
      output.push({ id, kind: 'output', type: 'function_call', callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), status: 'completed' });
    }
  });
  if (message.stop_reason === 'refusal') {
    output.push({
      id: `${message.id}:refusal`,
      kind: 'output',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'refusal', refusal: 'The assistant declined this request.' }],
    });
  }
  const incomplete = message.stop_reason === 'max_tokens';
  return {
    id: message.id,
    createdAt: Date.now(),
    output,
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
    model: message.model,
  };
}

export function failedResponse(code: string, message: string): AgLlmResponse {
  return { id: `err_${Date.now()}`, createdAt: Date.now(), output: [], status: 'failed', error: { code, message } };
}

export type BuiltRequest = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** The Messages API request for one Studio turn, or a reason it cannot be sent. */
export function buildRequest(
  request: AgLlmRequest,
  cache: TurnCache,
  sid: string,
  model: string,
): { ok: true; params: BuiltRequest; replayed: number } | { ok: false; message: string } {
  const { system, messages, replayed } = toMessages(request.input, cache, sid);
  if (messages.length === 0 || messages[0]?.role !== 'user') return { ok: false, message: 'The conversation must start with a user message.' };
  const note = toolChoiceNote(request);
  // A trailing assistant turn would be a prefill, which current models reject.
  if (messages.at(-1)?.role === 'assistant') pushBlocks(messages, 'user', [{ type: 'text', text: note ?? 'Continue.' }]);
  const instructions = [request.instructions, ...system, note].filter((s): s is string => s !== undefined && s !== '');
  const tools = toTools(request);
  const format =
    request.responseFormat?.type === 'json'
      ? { format: { type: 'json_schema' as const, schema: request.responseFormat.schema as Record<string, unknown> } }
      : {};
  const params: BuiltRequest = {
    model,
    max_tokens: AI_MAX_TOKENS,
    betas: AI_BETAS,
    fallbacks: 'default',
    cache_control: { type: 'ephemeral' },
    output_config: { effort: 'low', ...format },
    ...(instructions.length > 0 ? { system: instructions.join('\n\n') } : {}),
    ...(tools === undefined ? {} : { tools }),
    messages,
  };
  return { ok: true, params, replayed };
}

/**
 * An Anthropic API error. `instanceof` holds when the client and this module share a chunk; the
 * structural test covers a client created by another chunk's copy of the SDK (see `brand.ts`).
 */
function isAnthropicApiError(error: unknown): error is { status: number | undefined } {
  if (error instanceof Anthropic.APIError) return true;
  return typeof error === 'object' && error !== null && 'headers' in error && 'error' in error && 'status' in error && (typeof error.status === 'number' || error.status === undefined);
}

/** Runs one turn against Claude and remembers it. Errors become a `failed` response. */
export async function runTurn(options: {
  request: AgLlmRequest;
  client: Anthropic;
  cache: TurnCache;
  sid: string;
  model: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<{ status: number; body: AgLlmResponse }> {
  const built = buildRequest(options.request, options.cache, options.sid, options.model);
  if (!built.ok) return { status: 400, body: failedResponse('bad_request', built.message) };
  options.log?.(`[ai/turn] ${options.request.input.length} items, replayed ${built.replayed} cached turns`);
  try {
    const message = await options.client.beta.messages.create(built.params, options.signal === undefined ? {} : { signal: options.signal });
    options.cache.remember(options.sid, message.id, message.content as ContentBlockParam[]);
    return { status: 200, body: toResponse(message) };
  } catch (error) {
    if (isAnthropicApiError(error)) {
      options.log?.(`[ai/turn] Claude API error ${error.status ?? 'connection'}`);
      return { status: 502, body: failedResponse(`anthropic_${error.status ?? 'error'}`, 'The assistant could not answer. Try again in a moment.') };
    }
    throw error;
  }
}
