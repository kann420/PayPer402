/**
 * Paid calls as AG Studio rows (design spec §11.2, §11.3), the paging that loads them, and the
 * charge-detail grouping (§10.9).
 */
import type { Catalog } from '@payper402/agent';
import { serviceFor } from './catalog';
import { centsToUsd, formatUsd } from './money';
import { CALL_STATE, type CallState } from './status';
import type { PaidCallRow } from './studio-config';
import { isoDay, isoTime, utcDayStart } from './time';

export const ROW_CAP = 5000;
export const PAGE_LIMIT = 500;
export const DAY_SECONDS = 86_400;

export interface CallLike {
  id: string;
  recordedAt: number;
  path: string;
  amount: number;
  state: string;
  settlementId: string | null;
}

/** `stl_9f2a…`: the first 8 characters of a settlement id. */
export function shortCharge(id: string | null): string {
  return id === null ? '' : `${id.slice(0, 8)}…`;
}

export function stateLabel(state: string): string {
  return Object.hasOwn(CALL_STATE, state) ? CALL_STATE[state as CallState].label : state;
}

/** One paid call to a Studio row. `agent` is the agent name, or "Agent <ref>" for sellers. */
export function toRow(call: CallLike, agent: string, catalog: Catalog | undefined): PaidCallRow {
  const label = serviceFor(catalog, call.path);
  return {
    id: call.id,
    time: isoTime(call.recordedAt),
    day: isoDay(call.recordedAt),
    agent,
    service: label.service,
    endpoint: label.endpoint,
    path: call.path.split('?')[0] ?? call.path,
    price: centsToUsd(call.amount),
    status: stateLabel(call.state),
    charge: shortCharge(call.settlementId),
  };
}

export function operatorRows(calls: (CallLike & { agentName: string })[], catalog: Catalog | undefined): PaidCallRow[] {
  return calls.map((c) => toRow(c, c.agentName, catalog));
}

export function sellerRows(calls: (CallLike & { agentRef: string })[], catalog: Catalog | undefined): PaidCallRow[] {
  return calls.map((c) => toRow(c, `Agent ${c.agentRef}`, catalog));
}

/** Short charge id to full id, for the Charge column links. */
export function chargeLinks(calls: CallLike[]): Record<string, string> {
  const links: Record<string, string> = {};
  for (const c of calls) if (c.settlementId !== null) links[shortCharge(c.settlementId)] = c.settlementId;
  return links;
}

export interface Loaded<T> {
  calls: T[];
  /** True when the 5,000-row cap was reached. */
  capped: boolean;
}

/**
 * Loads paid calls newest first (design spec §11.3). The facilitator filters `recorded_at <
 * before`, so the next page uses the last row's `recordedAt + 1` and rows are de-duplicated by id:
 * a page that ends inside one second never skips that second's other rows (as long as one second
 * holds fewer rows than a page, 500). Paging stops at the cap, at the `since` cutoff, on a short
 * page, or when a page adds no new row.
 */
export async function loadCalls<T extends { id: string; recordedAt: number }>(
  page: (query: { since: number; before?: number; limit: number }) => Promise<T[]>,
  options: { since: number; cap?: number; limit?: number },
): Promise<Loaded<T>> {
  const cap = options.cap ?? ROW_CAP;
  const limit = options.limit ?? PAGE_LIMIT;
  const seen = new Set<string>();
  const calls: T[] = [];
  let before: number | undefined;
  for (;;) {
    const rows = await page({ since: options.since, limit, ...(before === undefined ? {} : { before }) });
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      calls.push(row);
      added += 1;
      if (calls.length >= cap) return { calls, capped: true };
    }
    const last = rows.at(-1);
    if (added === 0 || last === undefined || rows.length < limit || last.recordedAt <= options.since) return { calls, capped: false };
    before = last.recordedAt + 1;
  }
}

/** The start of the 30-day window, in unix seconds (whole UTC days). */
export function windowStart(now: number, days = 30): number {
  return utcDayStart(now) - (days - 1) * DAY_SECONDS;
}

export interface ServiceGroup {
  service: string;
  calls: number;
  totalCents: number;
  /** "N × $unit = $total", or "N calls = $total" when prices differ. */
  text: string;
}

/** The charge detail's "By service" groups (design spec §10.9). */
export function groupByService(calls: { path: string; amount: number }[], catalog: Catalog | undefined): ServiceGroup[] {
  const groups = new Map<string, { calls: number; totalCents: number; prices: Set<number> }>();
  for (const c of calls) {
    const name = serviceFor(catalog, c.path).service;
    const g = groups.get(name) ?? { calls: 0, totalCents: 0, prices: new Set<number>() };
    g.calls += 1;
    g.totalCents += c.amount;
    g.prices.add(c.amount);
    groups.set(name, g);
  }
  return [...groups.entries()]
    .map(([service, g]) => ({
      service,
      calls: g.calls,
      totalCents: g.totalCents,
      text:
        g.prices.size === 1
          ? `${g.calls} × ${formatUsd([...g.prices][0] as number)} = ${formatUsd(g.totalCents)}`
          : `${g.calls} calls = ${formatUsd(g.totalCents)}`,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

/** Gross revenue over the last 7 UTC days, including today (design spec §10.11). */
export function weekRevenue(calls: { recordedAt: number; amount: number }[], now: number): number {
  const from = utcDayStart(now) - 6 * DAY_SECONDS;
  return calls.filter((c) => c.recordedAt >= from).reduce((sum, c) => sum + c.amount, 0);
}
