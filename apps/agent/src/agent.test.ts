import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_BETAS, FINISH_SCHEMA, SYSTEM_PROMPT, runAgent } from './agent';
import type { AgentEvent } from './events';
import { openSession } from './session';
import { fakeAnthropic, fetchSpy, message, startDemoEnv, text, thinking, toolUse, type Env, type ScriptedReply } from './test-support';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const TASK = 'Brief me on coffee';

async function run(script: (e: Env) => ScriptedReply[], options: { maxIterations?: number; maxPerCallCents?: number } = {}) {
  env = await startDemoEnv();
  const spy = fetchSpy();
  const session = await openSession({
    sellerUrl: env.url,
    privateKey: env.key.privateKey,
    budgetCents: 100,
    maxPerCallCents: options.maxPerCallCents ?? 10,
    fetch: spy.fetch,
  });
  const fake = fakeAnthropic(script(env));
  const result = await runAgent({
    task: TASK,
    session,
    anthropic: fake.client,
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
  });
  return { result, fake, spy, session, env };
}

const quoteCall = (id?: string) => toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC' }, reason: 'Need the price' }, id);
const finishCall = () => toolUse('finish', { answer: 'Coffee is up (simulated data).', spend_explanation: 'I paid for a quote and a summary.' });
const types = (events: readonly AgentEvent[]) => events.map((e) => e.type);

type ToolResultBlock = { type: string; tool_use_id: string; content: unknown; is_error?: boolean };
function toolResults(body: Record<string, unknown>): ToolResultBlock[] {
  const messages = body['messages'] as { role: string; content: unknown }[];
  const last = messages.at(-1);
  return Array.isArray(last?.content) ? (last.content as ToolResultBlock[]).filter((b) => b.type === 'tool_result') : [];
}

describe('runAgent', () => {
  it('sends the §6.1 request on every request, with no tool_choice and the first user message', async () => {
    const { fake } = await run(() => [message([toolUse('list_services', {})]), message([finishCall()])]);
    expect(fake.requests).toHaveLength(2);
    for (const request of fake.requests) {
      expect(request.body).toMatchObject({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive', display: 'updates' },
        output_config: { effort: 'medium' },
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        system: SYSTEM_PROMPT,
      });
      expect(request.body).not.toHaveProperty('tool_choice');
      expect(request.body).not.toHaveProperty('max_iterations');
      expect(request.headers['anthropic-beta']?.split(',').map((s) => s.trim())).toEqual(expect.arrayContaining([...AGENT_BETAS]));
      const tools = request.body['tools'] as { name: string; strict?: boolean; input_schema: Record<string, unknown> }[];
      expect(tools.map((t) => [t.name, t.strict === true])).toEqual([
        ['list_services', true],
        ['call_service', false],
        ['get_budget', true],
        ['finish', true],
      ]);
      const callSchema = tools[1]?.input_schema as { properties: { service_id: { enum: string[] } } };
      expect(callSchema.properties.service_id.enum).toEqual(['quote', 'summarize', 'translate', 'premium_news']);
    }
    const messages = fake.requests[0]?.body['messages'] as { role: string; content: string }[];
    expect(messages).toEqual([{ role: 'user', content: `Task: ${TASK}\n\nBudget for this run: $1.00. Per-call limit: $0.10.` }]);
  });

  it('keeps the system prompt byte-identical between runs', async () => {
    const first = await run(() => [message([finishCall()])]);
    await first.env.close();
    env = undefined;
    const second = await run(() => [message([finishCall()])]);
    expect(first.fake.requests[0]?.body['system']).toBe(second.fake.requests[0]?.body['system']);
    expect(first.fake.requests[0]?.body['system']).toBe(SYSTEM_PROMPT);
  });

  it('asks for a plan note before the first paid call and an English spend explanation (web-app spec §6)', () => {
    expect(SYSTEM_PROMPT).toContain(
      '- Before your first call_service, write one short sentence that says what you plan to buy and\n  why.',
    );
    expect(SYSTEM_PROMPT).toContain('Write that paragraph in English, whatever language\n  the answer is in.');
    expect(SYSTEM_PROMPT.indexOf('Call list_services first')).toBeLessThan(SYSTEM_PROMPT.indexOf('Before your first call_service'));
    expect(SYSTEM_PROMPT.trimEnd().endsWith('Do not state amounts the tools did not report.')).toBe(true);
  });

  it("asks for the spend explanation in English in the finish tool too (agent.md §5)", () => {
    expect(FINISH_SCHEMA.properties['spend_explanation']).toEqual({
      type: 'string',
      description: 'Two to four sentences, in English: what you paid for, what you skipped and why',
    });
  });

  it('keeps the history append-only', async () => {
    const { fake } = await run((e) => [
      message([thinking('Look first'), toolUse('list_services', {})]),
      message([quoteCall()]),
      message([toolUse('call_service', { service_id: 'summarize', params: { url: `${e.url}/news/coffee-port-congestion-eases` }, reason: 'News' })]),
      message([finishCall()]),
    ]);
    for (let i = 1; i < fake.requests.length; i += 1) {
      const before = fake.requests[i - 1]?.body['messages'] as unknown[];
      const after = fake.requests[i]?.body['messages'] as unknown[];
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });

  it('script list, quote, summarize, finish alone: events, completed, report, no request after finish', async () => {
    const { result, fake } = await run((e) => [
      message([thinking('I will check the catalog.'), toolUse('list_services', {})]),
      message([thinking(''), thinking('A quote is cheap.'), text('Getting the price.'), quoteCall()]),
      message([
        toolUse('call_service', { service_id: 'summarize', params: { url: `${e.url}/news/coffee-port-congestion-eases` }, reason: 'Top news' }),
      ]),
      message([finishCall()]),
    ]);
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Coffee is up (simulated data).');
    expect(types(result.events)).toEqual([
      'started',
      'thinking',
      'thinking',
      'thinking',
      'discovered_price',
      'decided',
      'paid',
      'discovered_price',
      'decided',
      'paid',
      'result',
    ]);
    expect(result.events.filter((e) => e.type === 'thinking').map((e) => (e.type === 'thinking' ? e.note : ''))).toEqual([
      'I will check the catalog.',
      'A quote is cheap.',
      'Getting the price.',
    ]);
    expect(result.events[0]).toMatchObject({ type: 'started', sellerName: 'Acme Data', budgetCents: 100, maxPerCallCents: 10, task: TASK });
    expect(result.report.lines.map((l) => l.serviceId)).toEqual(['quote', 'summarize']);
    expect(result.report.notUsed.map((s) => s.serviceId)).toEqual(['translate', 'premium_news']);
    expect(result.report.explanation).toBe('I paid for a quote and a summary.');
    expect(result.events.at(-1)).toMatchObject({ type: 'result', status: 'completed', report: result.report });
    expect(fake.requests).toHaveLength(4);
    const listResult = toolResults(fake.requests[1]?.body ?? {})[0];
    expect(JSON.parse(String(listResult?.content))).toMatchObject({
      seller: { name: 'Acme Data' },
      services: expect.arrayContaining([expect.objectContaining({ id: 'premium_news', price: '$0.25', withinLimits: false })]),
    });
  });

  it('finish together with another tool use: the other tool runs, and the run stops when the next message arrives', async () => {
    const { result, fake, env: e } = await run(() => [message([quoteCall(), finishCall()]), message([text('ignored')], 'end_turn')]);
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Coffee is up (simulated data).');
    expect(e.ledger.size).toBe(1);
    expect(fake.requests).toHaveLength(2);
    expect(toolResults(fake.requests[1]?.body ?? {}).map((r) => r.content)).toContain('Recorded.');
    expect(result.events.filter((ev) => ev.type === 'thinking')).toHaveLength(0);
  });

  it('finish together with quote, then a 529 on the next request: completed with the recorded finish', async () => {
    const { result, fake, env: e } = await run(() => [
      message([quoteCall(), finishCall()]),
      { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]);
    expect(fake.requests).toHaveLength(2);
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Coffee is up (simulated data).');
    expect(result.report.explanation).toBe('I paid for a quote and a summary.');
    expect(result.report.lines).toEqual([expect.objectContaining({ serviceId: 'quote', calls: 1 })]);
    expect(e.ledger.size).toBe(1);
    expect(result.events.some((ev) => ev.type === 'failed')).toBe(false);
    expect(result.events.at(-1)).toMatchObject({ type: 'result', status: 'completed' });
  });

  it('an invalid finish together with quote, then a 529: error, because nothing was recorded', async () => {
    const { result } = await run(() => [
      message([text('Paying for a quote.'), quoteCall(), toolUse('finish', { answer: '', spend_explanation: 'x' })]),
      { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]);
    expect(result.status).toBe('error');
    expect(result.answer).toBe('Paying for a quote.');
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'failed', note: 'The model request failed (HTTP 529)' }));
  });

  it('a premium_news call over the per-call limit is refused locally with no HTTP request', async () => {
    const { result, fake, spy } = await run(() => [
      message([toolUse('call_service', { service_id: 'premium_news', params: { topic: 'coffee' }, reason: 'Full coverage' })]),
      message([finishCall()]),
    ]);
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'refused', code: 'over_per_call_limit', by: 'agent' }));
    expect(spy.calls).toHaveLength(0);
    const [refusal] = toolResults(fake.requests[1]?.body ?? {});
    expect(refusal?.is_error).toBe(true);
    expect(JSON.parse(String(refusal?.content))).toMatchObject({ ok: false, error: 'refused', code: 'over_per_call_limit' });
  });

  it('stop_reason refusal: status refused, and no tools of that message run', async () => {
    const { result, spy, fake } = await run(() => [message([quoteCall()], 'refusal')]);
    expect(result.status).toBe('refused');
    expect(result.answer).toBe('The model declined this task.');
    expect(spy.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
  });

  it('end_turn without finish: completed, with the text as the answer and an empty explanation', async () => {
    const { result } = await run(() => [message([thinking('Done.'), text('Here is the brief.')], 'end_turn')]);
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Here is the brief.');
    expect(result.report.explanation).toBe('');
    expect(result.events.filter((e) => e.type === 'thinking').map((e) => (e.type === 'thinking' ? e.note : ''))).toEqual(['Done.']);
  });

  it('max_tokens: incomplete, and the tools of that message do not run', async () => {
    const { result, spy } = await run(() => [message([text('Partial'), quoteCall()], 'max_tokens')]);
    expect(result.status).toBe('incomplete');
    expect(result.answer).toBe('Partial');
    expect(spy.calls).toHaveLength(0);
  });

  it('the iteration limit: the third message tools never run, and exactly 3 requests are made', async () => {
    const { result, spy, fake } = await run(
      () => [message([text('Listing.'), toolUse('list_services', {})]), message([toolUse('get_budget', {})]), message([quoteCall()])],
      { maxIterations: 3 },
    );
    expect(result.status).toBe('incomplete');
    expect(result.answer).toBe('Listing.');
    expect(spy.calls).toHaveLength(0);
    expect(result.events.some((e) => e.type === 'paid')).toBe(false);
    expect(fake.requests).toHaveLength(3);
    for (const request of fake.requests) expect(request.body).not.toHaveProperty('max_iterations');
  });

  it('the iteration limit with finish: completed with the finish answer, and no quote request', async () => {
    const { result, spy, fake } = await run(
      () => [message([toolUse('list_services', {})]), message([toolUse('get_budget', {})]), message([quoteCall(), finishCall()])],
      { maxIterations: 3 },
    );
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Coffee is up (simulated data).');
    expect(spy.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(3);
  });

  it('a lone finish with invalid input ends the run as incomplete with the last text', async () => {
    const { result } = await run(() => [
      message([text('Working on it.'), toolUse('list_services', {})]),
      message([toolUse('finish', { answer: '', spend_explanation: 'x' })]),
    ]);
    expect(result.status).toBe('incomplete');
    expect(result.answer).toBe('Working on it.');
  });

  it('a 529 from the API: status error and a failed event without keys', async () => {
    const { result } = await run(() => [{ status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    expect(result.status).toBe('error');
    const failed = result.events.find((e) => e.type === 'failed');
    expect(failed).toMatchObject({ note: 'The model request failed (HTTP 529)', charged: 'no' });
    expect(JSON.stringify(result.events)).not.toContain('sk-ant');
    expect(result.events.at(-1)).toMatchObject({ type: 'result', status: 'error' });
  });

  it('paid calls made before an API error stay in the report', async () => {
    const { result } = await run(() => [message([quoteCall()]), { status: 500, error: { type: 'api_error', message: 'boom' } }]);
    expect(result.status).toBe('error');
    expect(result.report.lines).toEqual([expect.objectContaining({ serviceId: 'quote', calls: 1 })]);
  });

  it('invalid call_service input (an unknown param) is a tool error, and the run continues', async () => {
    const { result, fake } = await run(() => [
      message([toolUse('call_service', { service_id: 'quote', params: { symbol: 'KC', extra: 'x' }, reason: 'Price' })]),
      message([finishCall()]),
    ]);
    const [error] = toolResults(fake.requests[1]?.body ?? {});
    expect(error?.is_error).toBe(true);
    expect(JSON.parse(String(error?.content))).toMatchObject({
      ok: false,
      error: 'invalid_params',
      issues: [{ param: 'extra', message: 'unknown param' }],
      budget: { spentCents: 0, remainingCents: 100 },
    });
    expect(result.status).toBe('completed');
  });
});
