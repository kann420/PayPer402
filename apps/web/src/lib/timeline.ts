/**
 * The live run's model (design spec §10.10): run-stream frames to timeline rows, the budget meter,
 * and the end card. Pure and browser-safe: it imports only types from the agent package.
 */
import type { AgentEvent, RunStatus, SpendReport } from '@payper402/agent';
import { formatUsd } from './money';
import { formatTime } from './time';

/** Refusals that block the session (the agent's `BLOCKING_REFUSALS`; a test keeps them equal). */
export const BLOCKING_CODES = ['wallet_revoked', 'wallet_not_linked', 'agent_disabled', 'unknown_agent'] as const;
export type BlockingCode = (typeof BLOCKING_CODES)[number];

export function isBlocking(code: string): code is BlockingCode {
  return (BLOCKING_CODES as readonly string[]).includes(code);
}

export type RowKind = 'thinking' | 'price' | 'decided' | 'skip' | 'paid' | 'refused' | 'problem' | 'result';

export interface TimelineRow {
  key: string;
  kind: RowKind;
  label: string;
  service: string;
  time: string;
  text: string;
  /** A second line under the text. */
  extra?: string;
  chip?: { text: string; tone: 'price' | 'paid' | 'neutral' };
  /** Under the chip ("total $Y"). */
  chipSub?: string;
  /** The decision-layer chip. */
  jev?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  method: string;
  path: string;
  priceCents: number;
}

export interface Meter {
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  paidCalls: number;
  skippedCalls: number;
  skippedCents: number;
}

export type RunPhase = 'idle' | 'running' | 'finished' | 'blocked' | 'error';

export interface RunView {
  phase: RunPhase;
  rows: TimelineRow[];
  meter: Meter;
  catalog: CatalogEntry[];
  prices: Record<string, number>;
  result?: { status: RunStatus; answer: string; report: SpendReport };
  blocked?: { code: BlockingCode };
  error?: string;
}

export function initialRun(budgetCents: number): RunView {
  return {
    phase: 'idle',
    rows: [],
    meter: { budgetCents, spentCents: 0, remainingCents: budgetCents, paidCalls: 0, skippedCalls: 0, skippedCents: 0 },
    catalog: [],
    prices: {},
  };
}

const p2 = (n: number) => n.toFixed(2);
const RULE_LABEL: Record<string, string> = { not_needed: 'not needed', already_covered: 'already covered' };

export const RESULT_TEXT: Record<RunStatus, string> = {
  completed: 'Answer ready. Spend report written.',
  incomplete: 'The run stopped before finishing.',
  refused: 'The model declined this task.',
  error: 'The run failed.',
};

/** The row of one agent event, or undefined for `started`. */
export function rowFor(event: AgentEvent, view: Pick<RunView, 'catalog' | 'prices'>, index: number): TimelineRow | undefined {
  const time = formatTime(Math.floor(event.at / 1000));
  const key = `${index}-${event.type}`;
  switch (event.type) {
    case 'started':
      return undefined;
    case 'thinking':
      return { key, kind: 'thinking', label: 'Thinking', service: '', time, text: event.note };
    case 'discovered_price': {
      const service = view.catalog.find((s) => s.id === event.serviceId);
      const endpoint = service === undefined ? event.serviceName : `${service.method} ${service.path}`;
      return {
        key,
        kind: 'price',
        label: 'Discovered price',
        service: event.serviceName,
        time,
        text: `${endpoint} answered 402 Payment required.`,
        chip: { text: `402 · ${formatUsd(event.priceCents)}/call`, tone: 'price' },
      };
    }
    case 'decided': {
      const row: TimelineRow = { key, kind: 'decided', label: 'Decided', service: event.serviceName, time, text: event.note };
      const check = event.check;
      if (check?.status === 'passed') row.jev = `Jev · serves task ${p2(check.servesTask)}`;
      else if (check?.status === 'flagged') row.jev = `Jev flagged · ${RULE_LABEL[check.wouldRefuse] ?? check.wouldRefuse} (observed)`;
      else if (check?.status === 'unavailable') row.jev = 'Jev unavailable';
      return row;
    }
    case 'paid':
      return {
        key,
        kind: 'paid',
        label: 'Paid',
        service: event.serviceName,
        time,
        text: `Signed payment promise · ${event.httpStatus} OK`,
        chip: { text: `−${formatUsd(event.amountCents)}`, tone: 'paid' },
        chipSub: `total ${formatUsd(event.spentCents)}`,
      };
    case 'refused': {
      if (event.by === 'facilitator') {
        return { key, kind: 'refused', label: 'Refused', service: event.serviceName, time, text: event.note };
      }
      const price = view.prices[event.callId];
      const row: TimelineRow = {
        key,
        kind: 'skip',
        label: 'Skipped',
        service: event.serviceName,
        time,
        text: event.detail === undefined ? event.note : `${event.note} (${event.detail})`,
      };
      if (price !== undefined) row.chip = { text: `${formatUsd(price)}/call`, tone: 'neutral' };
      if (event.check !== undefined) {
        row.jev =
          event.code === 'already_covered'
            ? `Jev · covered ${p2(event.check.alreadyCovered)}`
            : `Jev · serves task ${p2(event.check.servesTask)}`;
      }
      return row;
    }
    case 'failed': {
      const row: TimelineRow = { key, kind: 'problem', label: 'Problem', service: event.serviceName ?? '', time, text: event.note };
      if (event.charged === 'unknown') row.extra = 'It may still appear as a paid call.';
      return row;
    }
    case 'result':
      return { key, kind: 'result', label: 'Result', service: '', time, text: RESULT_TEXT[event.status] };
  }
}

/** Applies one frame of the run stream (design spec §14.2). */
export function reduceRun(view: RunView, frame: { event?: string; data?: unknown }): RunView {
  if (frame.event === 'catalog') {
    const data = frame.data as { services?: CatalogEntry[] };
    return { ...view, catalog: Array.isArray(data.services) ? data.services : [] };
  }
  if (frame.event === 'error') {
    const data = frame.data as { message?: string };
    return { ...view, phase: 'error', error: typeof data.message === 'string' ? data.message : 'The run failed.' };
  }
  if (frame.event === 'end') return { ...view, phase: view.blocked === undefined ? 'finished' : 'blocked' };
  if (frame.event !== 'agent') return view;

  const event = frame.data as AgentEvent;
  let next: RunView = { ...view };
  const meter = { ...view.meter };
  switch (event.type) {
    case 'started':
      next = { ...initialRun(event.budgetCents), catalog: view.catalog, phase: 'running' };
      return next;
    case 'discovered_price':
      next.prices = { ...view.prices, [event.callId]: event.priceCents };
      break;
    case 'decided':
      meter.remainingCents = event.remainingCents;
      break;
    case 'paid':
      meter.spentCents = event.spentCents;
      meter.remainingCents = event.remainingCents;
      meter.paidCalls += 1;
      break;
    case 'refused':
      if (event.by === 'agent') {
        meter.skippedCalls += 1;
        meter.skippedCents += view.prices[event.callId] ?? view.catalog.find((s) => s.id === event.serviceId)?.priceCents ?? 0;
      }
      if (isBlocking(event.code)) next.blocked = { code: event.code };
      break;
    case 'result':
      next.result = { status: event.status, answer: event.answer, report: event.report };
      meter.spentCents = event.report.spentCents;
      meter.remainingCents = event.report.remainingCents;
      break;
    default:
      break;
  }
  next.meter = meter;
  const row = rowFor(event, next, view.rows.length);
  if (row !== undefined) next.rows = [...view.rows, row];
  return next;
}

export interface EndCard {
  title: string;
  body: string;
  action: { label: string; href: string };
  /** Spent more than 0: the report card follows. */
  withReport: boolean;
}

const BLOCKED_BODY: Record<BlockingCode, { body: string; action: { label: string; href: string } }> = {
  wallet_revoked: {
    body: "The operator's PayPal link was stopped, so the first paid call was refused. Re-link to let agents pay again.",
    action: { label: 'Re-link PayPal account', href: '/app/onboarding/link' },
  },
  wallet_not_linked: { body: 'The operator has not linked a PayPal account.', action: { label: 'Link PayPal account', href: '/app/onboarding/link' } },
  agent_disabled: { body: 'This agent is paused.', action: { label: 'Go to Agents', href: '/app/agents' } },
  unknown_agent: { body: "This agent's key is not registered.", action: { label: 'Go to Agents', href: '/app/agents' } },
};

/** The red end card after a blocking refusal (design spec §10.10). */
export function endCard(view: RunView): EndCard | undefined {
  if (view.blocked === undefined) return undefined;
  const spent = view.result?.report.spentCents ?? view.meter.spentCents;
  const copy = BLOCKED_BODY[view.blocked.code];
  return {
    title: spent === 0 ? 'Run stopped. Nothing was charged.' : `Run stopped after ${formatUsd(spent)} of paid calls.`,
    body: copy.body,
    action: copy.action,
    withReport: spent > 0,
  };
}

/** The muted decision-layer line of the report. */
export function decisionLayerLine(report: SpendReport): string | undefined {
  const d = report.decisionLayer;
  if (d === undefined) return undefined;
  return `Decision layer: Jev (${d.model}) · ${d.passed} passed · ${d.blocked} blocked · ${d.flagged} flagged · ${d.unavailable} unavailable`;
}
