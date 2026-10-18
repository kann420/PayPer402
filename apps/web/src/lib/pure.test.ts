import { describe, expect, it } from 'vitest';
import { formatUsd } from './money';
import { sameOrigin } from './origin';
import { DAY, HOUR, SlidingWindow, clientKey } from './limits';
import { formatDate, formatDateTime, formatTime, isoDay, isoTime } from './time';
import {
  AGENT_STATUSES,
  AGENT_STATUS,
  BLOCK_REASONS,
  BLOCK_REASON_TEXT,
  CALL_STATE,
  CALL_STATES,
  SETTLEMENT_STATUS,
  SETTLEMENT_STATUSES,
  SETTLEMENT_TRIGGERS,
  TRIGGER,
  WALLET_STATUS,
  WALLET_STATUSES,
  agentBadge,
  callEntryByLabel,
  statusEntry,
} from './status';

describe('money', () => {
  it('formats cents as $D.CC', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1)).toBe('$0.01');
    expect(formatUsd(99)).toBe('$0.99');
    expect(formatUsd(100)).toBe('$1.00');
    expect(formatUsd(123456)).toBe('$1,234.56');
  });

  it('writes negative values with U+2212', () => {
    expect(formatUsd(-41)).toBe('−$0.41');
    expect(formatUsd(-123456)).toBe('−$1,234.56');
  });

  it('keeps the value exact for tabular display', () => {
    for (const cents of [0, 1, 7, 10, 99, 100, 101, 4990, 500000]) {
      const text = formatUsd(cents).replace(/[$,]/g, '');
      expect(Math.round(Number(text) * 100)).toBe(cents);
    }
  });
});

describe('time (UTC)', () => {
  const beforeMidnight = Date.UTC(2026, 10, 2, 23, 59, 59) / 1000;
  const afterMidnight = Date.UTC(2026, 10, 3, 0, 0, 1) / 1000;

  it('formats times and dates in UTC around midnight', () => {
    expect(formatTime(beforeMidnight)).toBe('23:59:59');
    expect(formatTime(afterMidnight)).toBe('00:00:01');
    expect(formatDateTime(beforeMidnight)).toBe('Nov 2, 23:59');
    expect(formatDateTime(afterMidnight)).toBe('Nov 3, 00:00');
    expect(formatDate(beforeMidnight)).toBe('Nov 2, 2026');
    expect(formatDate(afterMidnight)).toBe('Nov 3, 2026');
    expect(isoDay(beforeMidnight)).toBe('2026-11-02');
    expect(isoDay(afterMidnight)).toBe('2026-11-03');
    expect(isoTime(afterMidnight)).toBe('2026-11-03T00:00:01');
  });
});

describe('origin', () => {
  const origin = 'http://localhost:3000';
  const req = (headers: Record<string, string>) => new Request('http://localhost:3000/api/x', { method: 'POST', headers });

  it('passes the same origin and refuses a foreign one', () => {
    expect(sameOrigin(req({ origin }), origin)).toBe(true);
    expect(sameOrigin(req({ origin: 'http://evil.example' }), origin)).toBe(false);
    expect(sameOrigin(req({ origin: 'http://localhost:3001' }), origin)).toBe(false);
  });

  it('falls back to Referer without Origin, and refuses a request with neither', () => {
    expect(sameOrigin(req({ referer: 'http://localhost:3000/app/settings' }), origin)).toBe(true);
    expect(sameOrigin(req({ referer: 'http://evil.example/page' }), origin)).toBe(false);
    expect(sameOrigin(req({}), origin)).toBe(false);
    expect(sameOrigin(req({ referer: 'not a url' }), origin)).toBe(false);
  });
});

describe('limits', () => {
  it('counts hits in a sliding window with an injected clock', () => {
    let now = 0;
    const w = new SlidingWindow(2, HOUR, () => now);
    expect(w.allows('a')).toBe(true);
    w.hit('a');
    w.hit('a');
    expect(w.allows('a')).toBe(false);
    expect(w.allows('b')).toBe(true);
    now = HOUR - 1;
    expect(w.allows('a')).toBe(false);
    now = HOUR + 1;
    expect(w.allows('a')).toBe(true);
    expect(w.count('a')).toBe(0);
  });

  it('takes from several windows only when all allow it', () => {
    let now = 0;
    const perClient = new SlidingWindow(1, HOUR, () => now);
    const all = new SlidingWindow(5, DAY, () => now);
    expect(SlidingWindow.take([[perClient, 'x'], [all, 'all']])).toBe(true);
    expect(SlidingWindow.take([[perClient, 'x'], [all, 'all']])).toBe(false);
    expect(all.count('all')).toBe(1);
    now = 2 * HOUR;
    expect(SlidingWindow.take([[perClient, 'x'], [all, 'all']])).toBe(true);
    expect(all.count('all')).toBe(2);
  });

  it('keys clients by the first X-Forwarded-For address only behind a trusted proxy', () => {
    const r = new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(clientKey(r, false)).toBe('all');
    expect(clientKey(r, true)).toBe('203.0.113.7');
  });
});

describe('status vocabulary', () => {
  it('has an entry with a label and a glyph for every value of every domain', () => {
    for (const v of WALLET_STATUSES) expect(WALLET_STATUS[v].label.length * WALLET_STATUS[v].glyph.length).toBeGreaterThan(0);
    for (const v of AGENT_STATUSES) expect(AGENT_STATUS[v].glyph).not.toBe('');
    for (const v of CALL_STATES) expect(CALL_STATE[v].glyph).not.toBe('');
    for (const v of SETTLEMENT_STATUSES) expect(SETTLEMENT_STATUS[v].glyph).not.toBe('');
    for (const v of SETTLEMENT_TRIGGERS) expect(TRIGGER[v].label).not.toBe('');
    for (const v of BLOCK_REASONS) expect(BLOCK_REASON_TEXT[v]).not.toBe('');
  });

  it('uses the labels and tones of design spec §8.4', () => {
    expect(statusEntry('wallet', 'unlinking')).toEqual({ label: 'Unlinking…', glyph: '↻', tone: 'pending' });
    expect(statusEntry('call', 'uncollectable')).toEqual({ label: 'Not collected', glyph: '✕', tone: 'bad' });
    expect(statusEntry('call', 'settling')).toEqual({ label: 'Charging', glyph: '↻', tone: 'warn' });
    expect(statusEntry('settlement', 'needs_review')).toEqual({ label: 'Needs review', glyph: '!', tone: 'warn' });
    expect(statusEntry('settlement', 'mystery').tone).toBe('neutral');
    expect(callEntryByLabel('Not yet charged')?.tone).toBe('pending');
    expect(TRIGGER.relink.label).toBe('Re-link');
  });

  it('shows Paused before Blocked, and the reason as the tooltip', () => {
    expect(agentBadge('paused', 'wallet_not_active')).toEqual(AGENT_STATUS.paused);
    expect(agentBadge('active', 'daily')).toMatchObject({ label: 'Blocked', tooltip: 'Daily limit reached' });
    expect(agentBadge('active', 'wallet_not_active').tooltip).toBe('PayPal link not active');
    expect(agentBadge('active', 'total').tooltip).toBe('Total limit reached');
    expect(agentBadge('active', 'unsettled').tooltip).toBe('Waiting for the PayPal charge');
    expect(agentBadge('active', null)).toEqual(AGENT_STATUS.active);
  });
});
