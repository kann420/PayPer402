import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { AgAiConversationItem, AgLlmRequest } from 'ag-studio';
import { fakeAnthropic, message, text, thinking, toolUse } from '@payper402/agent/test-support';
import { buildRequest, toMessages, toolId, TurnCache } from '../ai-turn';
import { body, createWebHarness, type WebHarness } from '../test-support';
import { createAiTurnHandler, AI_BODY_LIMIT } from './ai-turn';
import { createSessionHandler } from './session';

const user = (t: string): AgAiConversationItem => ({ type: 'message', kind: 'input', role: 'user', content: [{ type: 'text', text: t }] }) as AgAiConversationItem;
const system = (t: string): AgAiConversationItem => ({ type: 'message', kind: 'input', role: 'system', content: [{ type: 'text', text: t }] }) as AgAiConversationItem;
const call = (id: string, callId: string, name = 'executeQuery', args = '{}'): AgAiConversationItem =>
  ({ id, kind: 'output', type: 'function_call', callId, name, arguments: args, status: 'completed' }) as AgAiConversationItem;
const output = (callId: string, out = '{"rows":[]}'): AgAiConversationItem => ({ type: 'function_call_output', callId, output: out }) as AgAiConversationItem;
const said = (id: string, t: string): AgAiConversationItem =>
  ({ id, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: t, annotations: [] }] }) as AgAiConversationItem;

const request = (input: AgAiConversationItem[], extra: Partial<AgLlmRequest> = {}): AgLlmRequest => ({ input, ...extra }) as AgLlmRequest;

describe('translation', () => {
  it('puts instructions and system items in system, and tools become input_schema objects', () => {
    const built = buildRequest(
      request([system('Dashboard context.'), user('How much?')], {
        instructions: 'You answer questions.',
        tools: [{ name: 'executeQuery', description: 'Run a query', parameters: { properties: { q: { type: 'string' } } } }],
      } as Partial<AgLlmRequest>),
      new TurnCache(),
      'sid',
      'claude-sonnet-5-5',
    );
    if (!built.ok) throw new Error(built.message);
    expect(built.params.system).toBe('You answer questions.\n\nDashboard context.');
    expect(built.params.tools).toEqual([{ name: 'executeQuery', description: 'Run a query', input_schema: { properties: { q: { type: 'string' } }, type: 'object' } }]);
    expect(built.params).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'low' },
    });
    expect('thinking' in built.params).toBe(false);
  });

  it('turns a forced tool choice into a prompt line', () => {
    const built = buildRequest(request([user('q')], { toolChoice: { type: 'function', name: 'complete_task' } } as Partial<AgLlmRequest>), new TurnCache(), 'sid', 'm');
    if (!built.ok) throw new Error(built.message);
    expect(built.params.system).toContain('Respond by calling the complete_task tool.');
    expect('tool_choice' in built.params).toBe(false);
  });

  it('sanitises preflight ids and keeps a call and its result matched', () => {
    const id = 'run:7-preflight-0';
    expect(toolId(id)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(toolId('x'.repeat(100))).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const { messages } = toMessages([user('q'), call('pre:0', id, 'viewSchema'), output(id)], new TurnCache(), 'sid');
    const use = (messages[1]?.content as { type: string; id?: string }[])[0];
    const result = (messages[2]?.content as { type: string; tool_use_id?: string }[])[0];
    expect(use?.id).toBe(toolId(id));
    expect(result?.tool_use_id).toBe(toolId(id));
  });

  it('nudges a trailing assistant turn, and groups parallel calls into one message each way', () => {
    const built = buildRequest(request([user('q'), said('x:0', 'Done.')]), new TurnCache(), 'sid', 'm');
    if (!built.ok) throw new Error(built.message);
    expect(built.params.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });

    const { messages } = toMessages([user('q'), call('a:0', 'c1'), call('a:1', 'c2'), output('c1'), output('c2')], new TurnCache(), 'sid');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]?.content).toHaveLength(2);
    expect(messages[2]?.content).toHaveLength(2);
  });

  it('maps a JSON responseFormat to output_config.format', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const built = buildRequest(request([user('q')], { responseFormat: { type: 'json', name: 'answer', schema } } as Partial<AgLlmRequest>), new TurnCache(), 'sid', 'm');
    if (!built.ok) throw new Error(built.message);
    expect(built.params.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema } });
  });
});

describe('turn cache', () => {
  const blocks = [{ type: 'thinking', thinking: 'secret plan', signature: 'sig' }, { type: 'text', text: 'Answer' }] as never;

  it('replays a session own turn by message id, once', () => {
    const cache = new TurnCache();
    cache.remember('sidA', 'msg_1', blocks);
    const { messages, replayed } = toMessages([user('q'), said('msg_1:1', 'Answer'), call('msg_1:2', 'c1'), user('more')], cache, 'sidA');
    expect(replayed).toBe(1);
    expect(messages[1]).toEqual({ role: 'assistant', content: blocks });
  });

  it('never replays another session turn; it is rebuilt from the history instead', () => {
    const cache = new TurnCache();
    cache.remember('sidA', 'msg_1', blocks);
    const { messages, replayed } = toMessages([user('q'), said('msg_1:1', 'Answer'), user('more')], cache, 'sidB');
    expect(replayed).toBe(0);
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Answer' }] });
  });

  it('evicts at 50 per sid and 2,000 in total, oldest first', () => {
    const cache = new TurnCache();
    for (let i = 0; i < 60; i++) cache.remember('one', `msg_${i}`, blocks);
    expect(cache.get('one', 'msg_9')).toBeUndefined();
    expect(cache.get('one', 'msg_10')).toBeDefined();
    expect(cache.size).toBe(50);
    const small = new TurnCache({ maxPerSid: 50, maxTotal: 100 });
    for (let s = 0; s < 3; s++) for (let i = 0; i < 40; i++) small.remember(`s${s}`, `msg_${i}`, blocks);
    expect(small.size).toBe(100);
    expect(small.get('s0', 'msg_19')).toBeUndefined();
    expect(small.get('s0', 'msg_20')).toBeDefined();
  });
});

describe('POST /api/ai/turn', () => {
  let w: WebHarness;
  beforeEach(async () => {
    w = await createWebHarness({ env: { WEB_LIMIT_AI_TURNS_PER_HOUR: '2' } });
  });
  afterEach(async () => {
    await w.close();
  });

  const post = (handler: (r: Request) => Promise<Response>, payload: unknown, scope = 'operator') =>
    handler(w.request(`/api/ai/turn?scope=${scope}`, { body: payload }));

  it('needs a session for the scope', async () => {
    const handler = createAiTurnHandler(w.deps, { client: () => fakeAnthropic([]).client, cache: new TurnCache() });
    const res = await post(handler, request([user('q')]));
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ status: 'failed', error: { code: 'no_session' } });
  });

  it('answers a 400 failed response to malformed items, without calling Claude', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    const claude = fakeAnthropic([]);
    const handler = createAiTurnHandler(w.deps, { client: () => claude.client, cache: new TurnCache() });
    const bad = [
      { input: [{ type: 'message', kind: 'input', role: 'user', content: 'not an array' }] },
      { input: [{ type: 'message', kind: 'input', role: 'user', content: [{ type: 'text' }] }] },
      { input: [{ type: 'function_call', callId: 7, name: 'x', arguments: '{}' }] },
      { input: [{ type: 'function_call_output', callId: 'c' }] },
      { input: [{ type: 'message', kind: 'output', content: [{ type: 'image' }] }] },
      { input: [null] },
      { input: [user('q')], tools: [{ description: 'no name' }] },
    ];
    for (const payload of bad) {
      const res = await post(handler, payload as unknown as AgLlmRequest, 'seller');
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(await body(res)).toMatchObject({ status: 'failed', error: { code: 'bad_request' } });
    }
    expect(claude.requests).toHaveLength(0);
  });

  it('maps text, tool use, refusal and max_tokens, and replays its own turn', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    const claude = fakeAnthropic([
      message([thinking('plan'), toolUse('executeQuery', { q: 'sum' }, 'toolu_1')]),
      message([text('$0.28 is not yet charged.')], 'end_turn'),
    ]);
    const cache = new TurnCache();
    const handler = createAiTurnHandler(w.deps, { client: () => claude.client, cache });
    const first = await body(await post(handler, request([user('How much?')]), 'seller'));
    expect(first).toMatchObject({ status: 'completed', output: [{ type: 'function_call', name: 'executeQuery', callId: 'toolu_1', arguments: '{"q":"sum"}' }] });
    const firstId = (first['output'] as { id: string }[])[0]?.id as string;
    const second = await body(
      await post(handler, request([user('How much?'), call(firstId, 'toolu_1', 'executeQuery', '{"q":"sum"}'), output('toolu_1', '{"total":0.28}')]), 'seller'),
    );
    expect(second).toMatchObject({ status: 'completed', output: [{ type: 'message', content: [{ type: 'text', text: '$0.28 is not yet charged.' }] }] });
    // The second request replayed the first turn with its thinking block.
    const sent = claude.requests[1]?.body['messages'] as { role: string; content: { type: string }[] }[];
    expect(sent[1]?.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(claude.requests[0]?.body['model']).toBe('claude-test-model');
    expect(w.logs.some((l) => l.includes('replayed 1 cached turns'))).toBe(true);
    expect(w.logs.join('\n')).not.toContain('How much?');
  });

  it('maps a refusal and max_tokens', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    const claude = fakeAnthropic([message([], 'refusal'), message([text('partial')], 'max_tokens')]);
    const handler = createAiTurnHandler(w.deps, { client: () => claude.client, cache: new TurnCache() });
    const refused = await body(await post(handler, request([user('q')]), 'seller'));
    expect(refused).toMatchObject({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] });
    const cut = await body(await post(handler, request([user('q')]), 'seller'));
    expect(cut).toMatchObject({ status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } });
  });

  it('answers the limits with the busy message, and caps the body at 256 KB', async () => {
    w.keep(await createSessionHandler(w.deps)(w.request('/api/session', { body: { role: 'seller' } })));
    const claude = fakeAnthropic([message([text('a')], 'end_turn'), message([text('b')], 'end_turn')]);
    const handler = createAiTurnHandler(w.deps, { client: () => claude.client, cache: new TurnCache() });
    await post(handler, request([user('q')]), 'seller');
    await post(handler, request([user('q')]), 'seller');
    const busy = await post(handler, request([user('q')]), 'seller');
    expect(busy.status).toBe(429);
    expect(await body(busy)).toMatchObject({ status: 'failed', error: { code: 'ai_limit', message: 'The assistant is busy. Try again in a few minutes.' } });
    const big = await post(handler, request([user('x'.repeat(AI_BODY_LIMIT))]), 'seller');
    expect(big.status).toBe(413);
    expect(claude.requests).toHaveLength(2);
  });
});
