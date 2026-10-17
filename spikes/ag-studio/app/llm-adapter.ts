// Browser half of the AG Studio LLM adapter. It posts each turn to our own server route, which
// holds the Anthropic key, then replays the finished turn as AG-UI content events.

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

export function createServerLlmAdapter(url = '/api/ai/turn'): AgLlmAdapter {
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
          const body = (await res.json()) as AgLlmResponse;
          return res.ok ? body : (body.error === undefined ? failed(String(res.status), res.statusText) : body);
        } catch (error) {
          if (options?.signal?.aborted) return { ...failed('cancelled', 'Cancelled'), status: 'cancelled' };
          return failed('network', error instanceof Error ? error.message : String(error));
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
