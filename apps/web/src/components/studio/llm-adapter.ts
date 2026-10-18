// Browser half of the AG Studio LLM adapter (design spec §12.3). It posts each turn to our own
// server route, which holds the Anthropic key, then replays the finished turn as AG-UI events.
import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from 'ag-studio';

function failed(code: string, message: string): AgLlmResponse {
  return { id: `err_${Date.now()}`, createdAt: Date.now(), output: [], status: 'failed', error: { code, message } };
}

function toEvents(response: AgLlmResponse): AgAiEvent[] {
  const events: AgAiEvent[] = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      const text = item.content.map((c) => (c.type === 'text' ? c.text : c.refusal)).join('');
      events.push(
        { type: 'TEXT_MESSAGE_START', messageId: item.id, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: item.id, delta: text },
        { type: 'TEXT_MESSAGE_END', messageId: item.id },
      );
    } else if (item.type === 'function_call') {
      events.push(
        { type: 'TOOL_CALL_START', toolCallId: item.callId, toolCallName: item.name },
        { type: 'TOOL_CALL_ARGS', toolCallId: item.callId, delta: item.arguments },
        { type: 'TOOL_CALL_END', toolCallId: item.callId },
      );
    }
  }
  return events;
}

export function createServerLlmAdapter(scope: 'operator' | 'seller'): AgLlmAdapter {
  const url = `/api/ai/turn?scope=${scope}`;
  return {
    executeTurn(request: AgLlmRequest, options) {
      const complete = (async (): Promise<AgLlmResponse> => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          });
          const body = (await res.json().catch(() => undefined)) as AgLlmResponse | { message?: string } | undefined;
          if (body !== undefined && 'output' in body) return body;
          return failed(String(res.status), body?.message ?? 'The assistant is unavailable right now.');
        } catch (error) {
          if (options?.signal?.aborted) return { ...failed('cancelled', 'Cancelled'), status: 'cancelled' };
          return failed('network', error instanceof Error ? error.message : 'Network error');
        }
      })();
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            yield* toEvents(await complete);
          },
        },
        complete,
      };
    },
  };
}
