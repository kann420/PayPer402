import { describe, expect, it } from 'vitest';
import { BLOCKING_REFUSALS, type AgentEvent, type SpendReport } from '@payper402/agent';
import { BLOCKING_CODES, decisionLayerLine, endCard, initialRun, reduceRun, type RunView } from './timeline';

const AT = Date.UTC(2026, 10, 2, 10, 42, 7);
const catalog = {
  services: [
    { id: 'hotel_search', name: 'Hotel Search API', method: 'GET', path: '/v1/hotels/search', priceCents: 2 },
    { id: 'price_forecast', name: 'Price Forecast API (premium)', method: 'GET', path: '/v1/hotels/forecast', priceCents: 25 },
  ],
};
const report = (extra: Partial<SpendReport> = {}): SpendReport => ({
  sellerName: 'Acme Data',
  budgetCents: 100,
  spentCents: 2,
  uncertainCents: 0,
  remainingCents: 98,
  lines: [{ serviceId: 'hotel_search', serviceName: 'Hotel Search API', calls: 1, unitPriceCents: 2, totalCents: 2 }],
  notUsed: [{ serviceId: 'price_forecast', serviceName: 'Price Forecast API (premium)', priceCents: 25 }],
  refusals: [],
  commitmentIds: ['c1'],
  explanation: 'I paid for one search.',
  ...extra,
});

const agent = (event: AgentEvent) => ({ event: 'agent', data: event });
const play = (events: AgentEvent[], end = true): RunView => {
  let view = reduceRun(initialRun(100), { event: 'catalog', data: catalog });
  for (const e of events) view = reduceRun(view, agent(e));
  return end ? reduceRun(view, { event: 'end', data: { status: 'completed' } }) : view;
};

const started: AgentEvent = { type: 'started', at: AT, sellerName: 'Acme Data', budgetCents: 100, maxPerCallCents: 10 };
const price = (callId: string, serviceId = 'hotel_search', cents = 2): AgentEvent => ({
  type: 'discovered_price',
  at: AT,
  callId,
  serviceId,
  serviceName: serviceId === 'hotel_search' ? 'Hotel Search API' : 'Price Forecast API (premium)',
  priceCents: cents,
  catalogPriceCents: cents,
});

describe('timeline rows', () => {
  it('maps every event type to its row', () => {
    const view = play(
      [
        started,
        { type: 'thinking', at: AT, note: 'I will search first.' },
        price('call_1'),
        { type: 'decided', at: AT, callId: 'call_1', serviceId: 'hotel_search', serviceName: 'Hotel Search API', priceCents: 2, note: 'Cheap and needed.', remainingCents: 98 },
        {
          type: 'paid',
          at: AT,
          callId: 'call_1',
          serviceId: 'hotel_search',
          serviceName: 'Hotel Search API',
          amountCents: 2,
          commitmentId: 'c1',
          httpStatus: 200,
          spentCents: 2,
          remainingCents: 98,
        },
        { type: 'result', at: AT, status: 'completed', answer: 'The Stone Garden Inn fits.', report: report() },
      ],
      true,
    );
    expect(view.rows.map((r) => [r.kind, r.label])).toEqual([
      ['thinking', 'Thinking'],
      ['price', 'Discovered price'],
      ['decided', 'Decided'],
      ['paid', 'Paid'],
      ['result', 'Result'],
    ]);
    expect(view.rows[1]).toMatchObject({ service: 'Hotel Search API', text: 'GET /v1/hotels/search answered 402 Payment required.', chip: { text: '402 · $0.02/call' }, time: '10:42:07' });
    expect(view.rows[3]).toMatchObject({ text: 'Signed payment promise · 200 OK', chip: { text: '−$0.02', tone: 'paid' }, chipSub: 'total $0.02' });
    expect(view.rows[4]?.text).toBe('Answer ready. Spend report written.');
    expect(view.phase).toBe('finished');
  });

  it('shows the decision-layer chip for each check status', () => {
    const decided = (check: Extract<AgentEvent, { type: 'decided' }>['check']) =>
      play([started, price('call_1'), { type: 'decided', at: AT, callId: 'call_1', serviceId: 'hotel_search', serviceName: 'Hotel Search API', priceCents: 2, note: 'n', remainingCents: 98, ...(check === undefined ? {} : { check }) }], false).rows[1]?.jev;
    expect(decided({ status: 'passed', model: 'jev-1.14.0', servesTask: 0.96, alreadyCovered: 0.01, latencyMs: 300 })).toBe('Jev · serves task 0.96');
    expect(decided({ status: 'flagged', model: 'jev-1.14.0', servesTask: 0.2, alreadyCovered: 0.1, latencyMs: 300, wouldRefuse: 'not_needed' })).toBe(
      'Jev flagged · not needed (observed)',
    );
    expect(decided({ status: 'unavailable', note: 'timeout', latencyMs: 4000 })).toBe('Jev unavailable');
    expect(decided(undefined)).toBeUndefined();
  });

  it('shows an agent refusal as Skipped with the discovered price, and a facilitator refusal as Refused', () => {
    const view = play(
      [
        started,
        price('call_1', 'price_forecast', 25),
        { type: 'refused', at: AT, callId: 'call_1', serviceId: 'price_forecast', serviceName: 'Price Forecast API (premium)', code: 'over_per_call_limit', by: 'agent', note: 'Over the per-call limit' },
        price('call_2'),
        {
          type: 'refused',
          at: AT,
          callId: 'call_2',
          serviceId: 'hotel_search',
          serviceName: 'Hotel Search API',
          code: 'not_needed',
          by: 'agent',
          note: 'The decision layer judged this call not needed for the task',
          check: { status: 'blocked', model: 'jev-1.14.0', servesTask: 0.12, alreadyCovered: 0.05, latencyMs: 280 },
        },
        { type: 'refused', at: AT, callId: 'call_3', serviceId: 'hotel_search', serviceName: 'Hotel Search API', code: 'wallet_revoked', by: 'facilitator', note: "Payment required: the operator's PayPal link was stopped." },
      ],
      false,
    );
    const skipped = view.rows.filter((r) => r.kind === 'skip');
    expect(skipped[0]).toMatchObject({ label: 'Skipped', text: 'Over the per-call limit', chip: { text: '$0.25/call', tone: 'neutral' } });
    expect(skipped[1]?.jev).toBe('Jev · serves task 0.12');
    expect(view.rows.at(-1)).toMatchObject({ kind: 'refused', label: 'Refused', text: "Payment required: the operator's PayPal link was stopped." });
    expect(view.meter).toMatchObject({ skippedCalls: 2, skippedCents: 27 });
    expect(view.blocked).toEqual({ code: 'wallet_revoked' });
  });

  it('marks a failed call with an unknown outcome', () => {
    const view = play([started, { type: 'failed', at: AT, callId: 'call_1', serviceId: 'hotel_search', serviceName: 'Hotel Search API', note: 'The payment outcome is unknown', charged: 'unknown' }], false);
    expect(view.rows[0]).toMatchObject({ kind: 'problem', label: 'Problem', extra: 'It may still appear as a paid call.' });
    const plain = play([started, { type: 'failed', at: AT, note: 'The run was aborted', charged: 'no' }], false);
    expect(plain.rows[0]?.extra).toBeUndefined();
  });

  it('writes every result status', () => {
    const text = (status: 'completed' | 'incomplete' | 'refused' | 'error') => play([started, { type: 'result', at: AT, status, answer: '', report: report() }]).rows[0]?.text;
    expect(text('completed')).toBe('Answer ready. Spend report written.');
    expect(text('incomplete')).toBe('The run stopped before finishing.');
    expect(text('refused')).toBe('The model declined this task.');
    expect(text('error')).toBe('The run failed.');
  });
});

describe('meter and end card', () => {
  it('follows the events of a scripted run', () => {
    let view = reduceRun(initialRun(500), { event: 'catalog', data: catalog });
    view = reduceRun(view, agent({ ...started, budgetCents: 100 }));
    expect(view.meter).toEqual({ budgetCents: 100, spentCents: 0, remainingCents: 100, paidCalls: 0, skippedCalls: 0, skippedCents: 0 });
    view = reduceRun(view, agent(price('call_1')));
    view = reduceRun(view, agent({ type: 'decided', at: AT, callId: 'call_1', serviceId: 'hotel_search', serviceName: 'Hotel Search API', priceCents: 2, note: 'n', remainingCents: 98 }));
    view = reduceRun(view, agent({ type: 'paid', at: AT, callId: 'call_1', serviceId: 'hotel_search', serviceName: 'Hotel Search API', amountCents: 2, commitmentId: 'c', httpStatus: 200, spentCents: 2, remainingCents: 98 }));
    view = reduceRun(view, agent({ type: 'refused', at: AT, callId: 'call_2', serviceId: 'price_forecast', serviceName: 'Price Forecast API (premium)', code: 'over_budget', by: 'agent', note: 'Over the run budget' }));
    expect(view.meter).toEqual({ budgetCents: 100, spentCents: 2, remainingCents: 98, paidCalls: 1, skippedCalls: 1, skippedCents: 25 });
    expect(view.phase).toBe('running');
  });

  it('writes the blocked end card: nothing charged, or spent more than 0 with the report', () => {
    const refused = (code: 'wallet_revoked' | 'wallet_not_linked' | 'agent_disabled' | 'unknown_agent'): AgentEvent => ({
      type: 'refused',
      at: AT,
      callId: 'call_9',
      serviceId: 'hotel_search',
      serviceName: 'Hotel Search API',
      code,
      by: 'facilitator',
      note: 'refused',
    });
    const none = play([started, refused('wallet_not_linked'), { type: 'result', at: AT, status: 'completed', answer: 'a', report: report({ spentCents: 0, lines: [] }) }]);
    expect(none.phase).toBe('blocked');
    expect(endCard(none)).toEqual({
      title: 'Run stopped. Nothing was charged.',
      body: 'The operator has not linked a PayPal account.',
      action: { label: 'Link PayPal account', href: '/app/onboarding/link' },
      withReport: false,
    });
    const some = play([started, refused('wallet_revoked'), { type: 'result', at: AT, status: 'completed', answer: 'a', report: report({ spentCents: 7 }) }]);
    expect(endCard(some)).toMatchObject({ title: 'Run stopped after $0.07 of paid calls.', withReport: true, action: { label: 'Re-link PayPal account' } });
    expect(endCard(play([started, refused('agent_disabled')]))?.body).toBe('This agent is paused.');
    expect(endCard(play([started, refused('unknown_agent')]))?.body).toBe("This agent's key is not registered.");
    expect(endCard(play([started]))).toBeUndefined();
  });

  it('keeps the blocking codes equal to the agent package', () => {
    expect(new Set(BLOCKING_CODES)).toEqual(new Set(BLOCKING_REFUSALS));
  });

  it('writes the decision-layer line', () => {
    expect(decisionLayerLine(report())).toBeUndefined();
    expect(
      decisionLayerLine(report({ decisionLayer: { model: 'jev-1.14.0', modes: { not_needed: 'enforce', already_covered: 'observe' }, passed: 3, blocked: 1, flagged: 0, unavailable: 0 } })),
    ).toBe('Decision layer: Jev (jev-1.14.0) · 3 passed · 1 blocked · 0 flagged · 0 unavailable');
  });

  it('records an error frame', () => {
    const view = reduceRun(initialRun(100), { event: 'error', data: { message: "The agent couldn't start: x" } });
    expect(view).toMatchObject({ phase: 'error', error: "The agent couldn't start: x" });
  });
});
