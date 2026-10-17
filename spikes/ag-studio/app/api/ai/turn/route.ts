// Server half of the AG Studio LLM adapter: one AG Studio turn in, one Claude Messages call out.
// The browser never sees the API key. Spike quality: in-memory cache, no auth, no rate limit.

import { existsSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AgAiConversationItem, AgAiOutputItem, AgLlmRequest, AgLlmResponse } from 'ag-studio';

export const runtime = 'nodejs';

// The repo keeps one shared .env at its root; Next only reads .env files next to the app.
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (process.env.ANTHROPIC_API_KEY === undefined && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const DEFAULT_MODEL = 'claude-opus-5-5';
const BETAS = ['server-side-fallback-2026-07-01'];
const MAX_TOKENS = 16000;

type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

// Claude's full assistant turns, keyed by message id. AG Studio keeps only the text and tool calls
// of a turn; replaying the original blocks (thinking and fallback blocks included) keeps the
// history append-only, as the API asks.
const turnCache = new Map<string, ContentBlockParam[]>();
const TURN_CACHE_LIMIT = 500;

function remember(id: string, content: ContentBlockParam[]): void {
  turnCache.set(id, content);
  if (turnCache.size > TURN_CACHE_LIMIT) {
    const oldest = turnCache.keys().next().value;
    if (oldest !== undefined) turnCache.delete(oldest);
  }
}

// Output item ids are `<claude message id>:<block index>`.
function claudeMessageId(itemId: string | undefined): string | undefined {
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

// Studio seeds "preflight" tool calls with ids like `<runId>-preflight-0`; Claude tool ids must
// match ^[a-zA-Z0-9_-]{1,64}$. Map every id the same way for a call and its result.
function toolId(callId: string): string {
  const clean = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.length <= 64 ? clean : `${clean.slice(0, 40)}_${clean.length}_${clean.slice(-16)}`;
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(args === '' ? '{}' : args);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toMessages(input: AgAiConversationItem[]): { system: string[]; messages: MessageParam[]; replayed: number } {
  const system: string[] = [];
  const messages: MessageParam[] = [];
  const replayed = new Set<string>();

  for (const item of input) {
    if (item.type === 'message' && item.kind === 'input') {
      const text = item.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (item.role === 'system') system.push(text);
      else if (text !== '') pushBlocks(messages, 'user', [{ type: 'text', text }]);
      continue;
    }
    if (item.type === 'function_call_output') {
      pushBlocks(messages, 'user', [{ type: 'tool_result', tool_use_id: toolId(item.callId), content: item.output }]);
      continue;
    }

    // Assistant output: replay Claude's original turn when it is still cached.
    const msgId = claudeMessageId(item.id);
    if (msgId !== undefined && turnCache.has(msgId)) {
      if (!replayed.has(msgId)) {
        replayed.add(msgId);
        pushBlocks(messages, 'assistant', turnCache.get(msgId)!);
      }
      continue;
    }
    if (item.type === 'message') {
      const text = item.content.map((c) => (c.type === 'text' ? c.text : c.refusal)).join('');
      if (text !== '') pushBlocks(messages, 'assistant', [{ type: 'text', text }]);
    } else if (item.type === 'function_call') {
      pushBlocks(messages, 'assistant', [
        { type: 'tool_use', id: toolId(item.callId), name: item.name, input: parseArguments(item.arguments) },
      ]);
    }
    // Reasoning items carry no signature, so they cannot be replayed; drop them.
  }
  return { system, messages, replayed: replayed.size };
}

function toTools(request: AgLlmRequest): Anthropic.Beta.BetaToolUnion[] | undefined {
  if (request.tools === undefined || request.tools.length === 0 || request.toolChoice === 'none') return undefined;
  return request.tools.map((tool) => {
    const schema = tool.parameters as Record<string, unknown>;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { ...schema, type: 'object' } as Anthropic.Beta.BetaTool.InputSchema,
    };
  });
}

// Forced tool choice is a 400 on current models, so steer from the prompt instead.
function toolChoiceNote(request: AgLlmRequest): string | undefined {
  const choice = request.toolChoice;
  if (choice === 'required') return 'Respond by calling one of the available tools.';
  if (typeof choice === 'object') return `Respond by calling the ${choice.name} tool.`;
  return undefined;
}

function toResponse(message: Anthropic.Beta.BetaMessage): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  message.content.forEach((block, index) => {
    const id = `${message.id}:${index}`;
    if (block.type === 'text' && block.text !== '') {
      output.push({
        id,
        kind: 'output',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'text', text: block.text, annotations: [] }],
      });
    } else if (block.type === 'tool_use') {
      output.push({
        id,
        kind: 'output',
        type: 'function_call',
        callId: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: 'completed',
      });
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

function failure(code: string, message: string, status: number): Response {
  const body: AgLlmResponse = {
    id: `err_${Date.now()}`,
    createdAt: Date.now(),
    output: [],
    status: 'failed',
    error: { code, message },
  };
  return Response.json(body, { status });
}

export async function POST(req: Request): Promise<Response> {
  let request: AgLlmRequest;
  try {
    request = (await req.json()) as AgLlmRequest;
  } catch {
    return failure('bad_request', 'The body must be JSON.', 400);
  }
  if (!Array.isArray(request.input)) return failure('bad_request', 'input must be an array.', 400);

  const { system, messages, replayed } = toMessages(request.input);
  console.info(`[ai/turn] ${request.input.length} items, replayed ${replayed} cached Claude turns`);
  if (messages.length === 0 || messages[0]!.role !== 'user') {
    return failure('bad_request', 'The conversation must start with a user message.', 400);
  }
  // Studio ends a delegated run with the assistant's text and a forced `complete_task` call.
  // A trailing assistant turn would be a prefill, which current models reject, so add a nudge.
  const note = toolChoiceNote(request);
  if (messages.at(-1)!.role === 'assistant') {
    pushBlocks(messages, 'user', [{ type: 'text', text: note ?? 'Continue.' }]);
  }

  const instructions = [request.instructions, ...system, note].filter(
    (s): s is string => s !== undefined && s !== '',
  );
  const tools = toTools(request);
  const format =
    request.responseFormat?.type === 'json'
      ? { format: { type: 'json_schema' as const, schema: request.responseFormat.schema as Record<string, unknown> } }
      : {};

  try {
    const message = await anthropic().beta.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        betas: BETAS,
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'medium', ...format },
        ...(instructions.length > 0 ? { system: instructions.join('\n\n') } : {}),
        ...(tools === undefined ? {} : { tools }),
        messages,
      },
      { signal: req.signal },
    );
    remember(message.id, message.content as ContentBlockParam[]);
    return Response.json(toResponse(message));
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error('[ai/turn] Claude API error', error.status, error.message);
      return failure(`anthropic_${error.status ?? 'error'}`, error.message, 502);
    }
    throw error;
  }
}
