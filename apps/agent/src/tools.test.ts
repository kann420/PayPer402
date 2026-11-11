import { afterEach, describe, expect, it } from 'vitest';
import { openSession } from './session';
import type { SpendCheck, SpendPolicy } from './spend-check';
import { startDemoEnv, type Env } from './test-support';
import { createToolCore } from './tools';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const STAY = { checkIn: '2027-03-30', checkOut: '2027-04-02' };
const ENFORCE: SpendPolicy = { notNeededBelow: 0.4, coveredAbove: 0.6, modes: { not_needed: 'enforce', already_covered: 'enforce' } };

async function callTool(checker: SpendCheck | undefined, params: Record<string, unknown>, options: { budgetCents?: number; maxPerCallCents?: number; serviceId?: string } = {}) {
  env ??= await startDemoEnv();
  const session = await openSession({
    sellerUrl: env.url,
    privateKey: env.key.privateKey,
    budgetCents: options.budgetCents ?? 100,
    maxPerCallCents: options.maxPerCallCents ?? 10,
    ...(checker === undefined ? {} : { spendCheck: { checker, task: 'Rate for one hotel only.', policy: ENFORCE } }),
  });
  const tool = createToolCore(session).find((t) => t.name === 'call_service');
  const output = await tool?.run({ service_id: options.serviceId ?? 'hotel_rates', params, reason: 'Price' });
  return { session, tool, output: output === undefined ? undefined : (JSON.parse(output.text) as Record<string, unknown>) };
}

describe('call_service tool result', () => {
  it('a Jev refusal carries check with the two probabilities', async () => {
    const checker: SpendCheck = { model: 'jev-test', check: async () => ({ model: 'jev-1.14.0', servesTask: 0.2, alreadyCovered: 0.1 }) };
    const { output } = await callTool(checker, { hotelId: 'gion-lantern-house', ...STAY });
    expect(output).toEqual({
      ok: false,
      error: 'refused',
      code: 'not_needed',
      message: 'The decision layer judged this call not needed for the task',
      check: { servesTask: 0.2, alreadyCovered: 0.1 },
      budget: { spentCents: 0, remainingCents: 100 },
    });
  });

  it('other refusals carry no check: duplicate_call and over_per_call_limit', async () => {
    const checker: SpendCheck = { model: 'jev-test', check: async () => ({ model: 'jev-1.14.0', servesTask: 0.9, alreadyCovered: 0.1 }) };
    const { session, tool } = await callTool(checker, { hotelId: 'higashiyama-stone-garden-inn', ...STAY });
    const duplicate = JSON.parse((await tool?.run({ service_id: 'hotel_rates', params: { hotelId: 'higashiyama-stone-garden-inn', ...STAY }, reason: 'Again' }))?.text ?? '{}') as Record<string, unknown>;
    expect(duplicate).toMatchObject({ ok: false, code: 'duplicate_call' });
    expect(duplicate).not.toHaveProperty('check');
    expect(session.paidCalls()).toBe(1);
    const { output } = await callTool(undefined, { city: 'kyoto', ...STAY }, { serviceId: 'price_forecast', budgetCents: 100, maxPerCallCents: 10 });
    expect(output).toMatchObject({ ok: false, code: 'over_per_call_limit' });
    expect(output).not.toHaveProperty('check');
  });
});
