import { describe, expect, it } from 'vitest';
import type { AgentEvent, SpendReport } from './events';
import { formatEvent, formatReport } from './format';

const base = { at: 1, callId: 'call_2', serviceId: 'summarize', serviceName: 'Page Summary API' };
const decided = { type: 'decided' as const, ...base, priceCents: 5, note: 'Top news', remainingCents: 93 };
const prefix = '[decide] call_2 pay $0.05 for Page Summary API: Top news (left after this: $0.93)';
const scored = { model: 'jev-1.14.0', latencyMs: 300 };

describe('format: decision-layer checks', () => {
  it.each<[AgentEvent, string]>([
    [decided, prefix],
    [{ ...decided, check: { status: 'passed', ...scored, servesTask: 0.78, alreadyCovered: 0.03 } }, `${prefix} | Jev: serves task 0.78, covered 0.03`],
    [
      { ...decided, check: { status: 'flagged', ...scored, servesTask: 0.12, alreadyCovered: 0.03, wouldRefuse: 'not_needed' } },
      `${prefix} | Jev would refuse (not_needed, serves task 0.12), observe-only`,
    ],
    [
      { ...decided, check: { status: 'flagged', ...scored, servesTask: 0.7, alreadyCovered: 0.905, wouldRefuse: 'already_covered' } },
      `${prefix} | Jev would refuse (already_covered, covered 0.91), observe-only`,
    ],
    [{ ...decided, check: { status: 'unavailable', note: 'timed out', latencyMs: 4000 } }, `${prefix} | Jev unavailable (timed out)`],
    [
      {
        type: 'refused',
        at: 1,
        callId: 'call_3',
        serviceId: 'quote',
        serviceName: 'Market Quote API',
        code: 'not_needed',
        by: 'agent',
        note: 'The decision layer judged this call not needed for the task',
        check: { status: 'blocked', ...scored, servesTask: 0.12, alreadyCovered: 0.02 },
      },
      '[refused] call_3 Market Quote API: The decision layer judged this call not needed for the task (not_needed, by agent) | Jev: serves task 0.12',
    ],
    [
      {
        type: 'refused',
        at: 1,
        callId: 'call_5',
        serviceId: 'translate',
        serviceName: 'Translate API',
        code: 'already_covered',
        by: 'agent',
        note: 'The decision layer judged this information already obtained',
        detail: 'Same as call_3',
        check: { status: 'blocked', ...scored, servesTask: 0.7, alreadyCovered: 0.91, repeatOf: 'call_3' },
      },
      '[refused] call_5 Translate API: The decision layer judged this information already obtained (already_covered, by agent) | Jev: covered 0.91, repeat of call_3',
    ],
    [
      {
        type: 'refused',
        at: 1,
        callId: 'call_4',
        serviceId: 'quote',
        serviceName: 'Market Quote API',
        code: 'duplicate_call',
        by: 'agent',
        note: 'This exact call was already made in this run',
        detail: 'Same as call_1 (paid)',
      },
      '[refused] call_4 Market Quote API: This exact call was already made in this run (duplicate_call, by agent)',
    ],
  ])('renders %j', (event, expected) => {
    const line = formatEvent(event);
    expect(line).toBe(expected);
    expect(line).toMatch(/^[\x20-\x7e]*$/);
  });

  it('appends the decision-layer summary line to the report', () => {
    const report: SpendReport = {
      sellerName: 'Acme Data',
      budgetCents: 100,
      spentCents: 2,
      uncertainCents: 0,
      remainingCents: 98,
      lines: [{ serviceId: 'quote', serviceName: 'Market Quote API', calls: 1, unitPriceCents: 2, totalCents: 2 }],
      notUsed: [],
      refusals: [],
      commitmentIds: [],
      explanation: '',
      decisionLayer: { model: 'jev-1.14.0', modes: { not_needed: 'enforce', already_covered: 'observe' }, passed: 3, blocked: 1, flagged: 2, unavailable: 0 },
    };
    expect(formatReport(report).split('\n').at(-1)).toBe('Decision layer: Jev (jev-1.14.0): 3 passed, 1 blocked, 2 flagged, 0 unavailable');
    const { decisionLayer: _omit, ...without } = report;
    expect(formatReport(without)).not.toContain('Decision layer');
  });
});
