import { describe, expect, it } from 'vitest';
import type { Catalog } from '@payper402/agent';
import { pickBanner, type BannerInput } from './banners';
import { chargeNote } from './charge';
import { groupByService, loadCalls, operatorRows, sellerRows, shortCharge, weekRevenue, windowStart } from './rows';
import { sellerKpis, weeklySettled } from './seller-kpis';
import { fieldDefinitions, withRangeLabel, initialState } from './studio-config';
import { lastCall } from './time';

const catalog: Catalog = {
  seller: { name: 'Acme Data', payTo: 'sel_1' },
  scheme: 'batch-settlement',
  network: 'paypal:sandbox',
  asset: 'USD',
  services: [
    { id: 'hotel_rates', name: 'Room Rates API', description: '', method: 'GET', path: '/v1/hotels/rates', priceCents: 1, params: {}, required: [] },
    { id: 'review_summary', name: 'Review Summary API', description: '', method: 'POST', path: '/v1/hotels/reviews/summary', priceCents: 5, params: {}, required: [] },
  ],
};

const T = Date.UTC(2026, 10, 2, 23, 59, 30) / 1000;

describe('rows', () => {
  it('turns commitments into Studio rows', () => {
    const rows = operatorRows(
      [
        { id: 'c1', recordedAt: T, path: '/v1/hotels/rates?hotelId=gion-lantern-house', amount: 1, state: 'unsettled', settlementId: null, agentName: 'trip-planner' },
        { id: 'c2', recordedAt: T + 60, path: '/v1/hotels/reviews/summary', amount: 5, state: 'settled', settlementId: 'stl_9f2aK3x8LmQpZ', agentName: 'price-watcher' },
        { id: 'c3', recordedAt: T, path: '/v1/unknown', amount: 3, state: 'uncollectable', settlementId: null, agentName: 'x' },
      ],
      catalog,
    );
    expect(rows[0]).toEqual({
      id: 'c1',
      time: '2026-11-02T23:59:30',
      day: '2026-11-02',
      agent: 'trip-planner',
      service: 'Room Rates API',
      endpoint: 'GET /v1/hotels/rates?hotelId=gion-lantern-house',
      path: '/v1/hotels/rates',
      price: 0.01,
      status: 'Not yet charged',
      charge: '',
    });
    expect(rows[1]).toMatchObject({ day: '2026-11-03', time: '2026-11-03T00:00:30', endpoint: 'POST /v1/hotels/reviews/summary', path: '/v1/hotels/reviews/summary', status: 'Charged', charge: 'stl_9f2a…' });
    expect(rows[2]).toMatchObject({ service: '/v1/unknown', endpoint: '/v1/unknown', path: '/v1/unknown', status: 'Not collected' });
    expect(sellerRows([{ id: 'c', recordedAt: T, path: '/v1/hotels/rates', amount: 1, state: 'settling', settlementId: 'stl_x', agentRef: '3f9a1be1' }], catalog)[0]).toMatchObject({
      agent: 'Agent 3f9a1be1',
      status: 'Charging',
    });
    expect(shortCharge(null)).toBe('');
  });

  const fakePages = (all: { id: string; recordedAt: number }[]) => {
    const calls: { since: number; before?: number; limit: number }[] = [];
    const page = async (q: { since: number; before?: number; limit: number }) => {
      calls.push(q);
      return all
        .filter((r) => r.recordedAt >= q.since && (q.before === undefined || r.recordedAt < q.before))
        .sort((a, b) => b.recordedAt - a.recordedAt || (a.id < b.id ? 1 : -1))
        .slice(0, q.limit);
    };
    return { page, calls };
  };

  it('pages with before = last + 1, keeps every row of a second split across pages, and never repeats one', async () => {
    // Pages of 4 end inside second 100, which holds three parallel calls.
    const all = [
      { id: 'x', recordedAt: 102 },
      { id: 'y', recordedAt: 101 },
      ...['a', 'b', 'c'].map((id) => ({ id, recordedAt: 100 })),
      { id: 'f', recordedAt: 99 },
      { id: 'g', recordedAt: 99 },
    ];
    const { page, calls } = fakePages(all);
    const loaded = await loadCalls(page, { since: 0, limit: 4 });
    expect(new Set(loaded.calls.map((r) => r.id))).toEqual(new Set(all.map((r) => r.id)));
    expect(loaded.calls).toHaveLength(7);
    expect(calls[1]?.before).toBe(101);
    expect(loaded.capped).toBe(false);
  });

  it('stops at the cap, at the since cutoff, and when a page adds no new row', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, recordedAt: 1000 - i }));
    const capped = await loadCalls(fakePages(many).page, { since: 0, limit: 10, cap: 25 });
    expect(capped).toMatchObject({ capped: true });
    expect(capped.calls).toHaveLength(25);

    const since = fakePages(many);
    const cut = await loadCalls(since.page, { since: 995, limit: 3 });
    expect(cut.calls.map((r) => r.recordedAt).every((t) => t >= 995)).toBe(true);
    expect(cut.calls).toHaveLength(6);

    // A full page of one second, larger than the page size: the next page repeats it and stops.
    const stuck = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, recordedAt: 50 }));
    const s = fakePages(stuck);
    const result = await loadCalls(s.page, { since: 0, limit: 2 });
    expect(result.calls).toHaveLength(2);
    expect(s.calls).toHaveLength(2);
  });

  it('computes the 30-day window and last-call text in UTC', () => {
    expect(windowStart(T)).toBe(Date.UTC(2026, 9, 4) / 1000);
    expect(lastCall(T, T)).toBe('23:59:30');
    expect(lastCall(T - 86_400, T)).toBe('Nov 1');
    expect(lastCall(null, T)).toBe('—');
  });
});

describe('charge detail', () => {
  it('groups by service, with the same-price and the mixed-price rendering', () => {
    const groups = groupByService(
      [
        { path: '/v1/hotels/rates?hotelId=gion-lantern-house', amount: 1 },
        { path: '/v1/hotels/rates?hotelId=kamo-river-suites', amount: 1 },
        { path: '/v1/hotels/reviews/summary', amount: 5 },
        { path: '/v1/hotels/reviews/summary', amount: 4 },
      ],
      catalog,
    );
    expect(groups).toEqual([
      { service: 'Review Summary API', calls: 2, totalCents: 9, text: '2 calls = $0.09' },
      { service: 'Room Rates API', calls: 2, totalCents: 2, text: '2 × $0.01 = $0.02' },
    ]);
  });

  it('writes the note of each status', () => {
    const base = { failureCode: null, failureReason: null, callsCount: 143 };
    expect(chargeNote({ ...base, status: 'completed' })).toBeUndefined();
    expect(chargeNote({ ...base, status: 'pending' })).toMatchObject({ title: 'Charging…', kind: 'charging' });
    expect(chargeNote({ ...base, status: 'needs_review' })?.text).toContain('will not be charged twice');
    expect(chargeNote({ ...base, status: 'failed', failureCode: 'declined' })).toMatchObject({
      title: 'Failure reason: PayPal declined the charge.',
      text: 'These 143 paid calls went back to Not yet charged and will be part of the next charge.',
    });
    expect(chargeNote({ ...base, status: 'failed', failureCode: 'payer_stopped' })?.text).toBe(
      'These 143 paid calls were not charged. They are marked Not collected and are charged first when you re-link.',
    );
    expect(chargeNote({ ...base, status: 'failed', failureCode: 'other', failureReason: 'Something odd' })?.title).toBe('Failure reason: Something odd');
  });
});

describe('banners (design spec §10.7)', () => {
  const view = (extra: Partial<BannerInput> = {}): BannerInput => ({
    wallet: { status: 'active' },
    caps: { daily: 1000 },
    usage: { notCollected: 312, spentTotal: 5000, notYetCharged: 495 },
    lastSettlement: null,
    blockReason: null,
    ...extra,
  });
  const settlement = (extra: Partial<NonNullable<BannerInput['lastSettlement']>>) => ({
    id: 'stl_1',
    trigger: 'threshold',
    status: 'completed',
    amount: 500,
    createdAt: Date.UTC(2026, 10, 2, 10, 40) / 1000,
    failureCode: null,
    ...extra,
  });

  it('picks each row, in priority order', () => {
    expect(pickBanner(view())).toBeUndefined();
    expect(pickBanner(view({ wallet: { status: 'stopped_by_payer' }, blockReason: 'wallet_not_active' }))).toEqual({
      kind: 'stopped',
      text: 'Your PayPal agreement was stopped. Agents are blocked. Re-link to resume. $3.12 of earlier usage will be charged first.',
    });
    expect(pickBanner(view({ wallet: { status: 'unlinking' }, lastSettlement: settlement({ trigger: 'unlink', status: 'pending', amount: 312 }) }))?.text).toBe(
      'The final charge of $3.12 is still processing. Your account unlinks when it completes.',
    );
    expect(pickBanner(view({ wallet: { status: 'waiting_for_approval' }, lastSettlement: settlement({ trigger: 'relink', status: 'pending', amount: 312 }) }))?.kind).toBe(
      'collecting',
    );
    for (const status of ['not_linked', 'link_failed', 'waiting_for_approval']) expect(pickBanner(view({ wallet: { status } }))?.kind).toBe('not_linked');
    expect(pickBanner(view({ lastSettlement: settlement({ status: 'failed', failureCode: 'declined' }) }))).toMatchObject({
      kind: 'declined',
      text: 'PayPal declined the $5.00 charge on Nov 2, 10:40. The calls went back to Not yet charged; we try again in 15 minutes.',
    });
    expect(pickBanner(view({ lastSettlement: settlement({ status: 'failed', failureCode: 'payer_stopped' }) }))).toBeUndefined();
    expect(pickBanner(view({ lastSettlement: settlement({ status: 'needs_review' }) }))?.kind).toBe('review');
    expect(pickBanner(view({ blockReason: 'daily' }))?.text).toBe('Agents spent $10.00 today. New paid calls are refused until midnight UTC.');
    expect(pickBanner(view({ blockReason: 'total' }))?.text).toBe('Agents spent $50.00 in total. Raise the total limit in Settings to let them pay again.');
    expect(pickBanner(view({ blockReason: 'unsettled' }))?.text).toBe('Unpaid usage reached $4.95. Agents pay again once the charge completes.');
  });

  it('lets the first condition win when several hold', () => {
    const many = view({
      wallet: { status: 'stopped_by_payer' },
      blockReason: 'daily',
      lastSettlement: settlement({ status: 'needs_review' }),
    });
    expect(pickBanner(many)?.kind).toBe('stopped');
    expect(pickBanner(view({ blockReason: 'daily', lastSettlement: settlement({ status: 'failed', failureCode: 'declined' }) }))?.kind).toBe('declined');
    expect(pickBanner(view({ wallet: { status: 'not_linked' }, lastSettlement: settlement({ status: 'needs_review' }) }))?.kind).toBe('not_linked');
  });
});

describe('seller KPIs', () => {
  const now = Date.UTC(2026, 10, 2, 12) / 1000;
  const day = (d: number, h = 9) => Date.UTC(2026, 10, 2 - d, h) / 1000;
  it('sums the last 7 UTC days, gross', () => {
    const calls = [
      { recordedAt: day(0), amount: 5 },
      { recordedAt: day(6, 0), amount: 2 },
      { recordedAt: Date.UTC(2026, 9, 26, 23, 59, 59) / 1000, amount: 100 },
      { recordedAt: day(1), amount: 4 },
    ];
    expect(weekRevenue(calls, now)).toBe(11);
    expect(sellerKpis(calls, 5, now)).toEqual({ revenueWeek: 11, changeVsYesterday: 25 });
    expect(sellerKpis([], 5, now).changeVsYesterday).toBeUndefined();
  });

  it('sums the completed settlements of the week, with fees', () => {
    expect(
      weeklySettled(
        [
          { createdAt: day(0), sellerAmount: 496, feeShare: 66, status: 'completed' },
          { createdAt: day(2), sellerAmount: 327, feeShare: 60, status: 'completed' },
          { createdAt: day(3), sellerAmount: 100, feeShare: null, status: 'pending' },
          { createdAt: day(9), sellerAmount: 900, feeShare: 80, status: 'completed' },
        ],
        now,
      ),
    ).toEqual({ gross: 823, fees: 126, net: 697 });
  });
});

describe('studio state', () => {
  it('lists id in every paid-call grid, so identical calls never merge', () => {
    for (const kind of ['overview', 'agent', 'charge', 'seller'] as const) {
      const state = initialState(kind, 'mono') as unknown as { pages: { widgets: Record<string, { type: string; dataMapping: { cols?: { id: string; aggregation?: string }[] } }> }[] };
      for (const widget of Object.values(state.pages[0]?.widgets ?? {})) {
        if (widget.type !== 'grid') continue;
        const cols = widget.dataMapping.cols ?? [];
        if (cols.some((c) => c.aggregation !== undefined)) continue;
        expect(cols.map((c) => c.id)).toContain('paid_calls.id');
      }
    }
  });

  it('groups the seller revenue chart by path, and shows grid times with their date', () => {
    const state = initialState('seller', 'mono') as unknown as { pages: { widgets: Record<string, { dataMapping: { categoryKey?: { id: string }[] } }> }[] };
    expect(state.pages[0]?.widgets['revenuePerEndpoint']?.dataMapping.categoryKey).toEqual([{ id: 'paid_calls.path' }]);
    const time = fieldDefinitions('operator').find((f) => f.id === 'time');
    expect(time).toMatchObject({ format: 'dateTimeFormat', formatOptions: { format: 'mmm d, hh:mm:ss' } });
    expect(fieldDefinitions('seller').map((f) => f.id)).toContain('path');
  });

  it('replaces the range subtitles', () => {
    const next = withRangeLabel(initialState('overview', 'mono', 'Last 14 days'), 'Last 7 days') as unknown as {
      pages: { widgets: Record<string, { format?: { subtitle?: { text?: string } } }> }[];
    };
    const subtitles = Object.values(next.pages[0]?.widgets ?? {}).map((w) => w.format?.subtitle?.text);
    expect(subtitles.filter((s) => s !== undefined)).toEqual(['Last 7 days', 'Last 7 days', 'Last 7 days']);
  });
});
