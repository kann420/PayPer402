import { describe, expect, it } from 'vitest';
import type { AgentStatus } from './facilitator-api';
import { formatStatus, formatUtc, stateOf, walletWording } from './status-format';

function status(overrides: Partial<Omit<AgentStatus, 'agent' | 'wallet' | 'caps' | 'usage'>> & {
  agent?: Partial<AgentStatus['agent']>;
  wallet?: Partial<AgentStatus['wallet']>;
  caps?: Partial<AgentStatus['caps']>;
  usage?: Partial<AgentStatus['usage']>;
} = {}): AgentStatus {
  const { agent, wallet, caps, usage, ...rest } = overrides;
  return {
    agent: {
      id: 'agt_1',
      name: 'research-bot',
      keyFingerprint: 'ed25519:Ab3dE9wXyz',
      status: 'active',
      createdAt: 1,
      spentToday: 15,
      spentTotal: 40,
      callsToday: 3,
      lastCallAt: 5,
      ...agent,
    },
    operator: { name: 'Northwind Research' },
    wallet: { status: 'active', stoppedAt: null, lastChargeAt: null, lastChargeAmount: null, lastChargeStatus: null, ...wallet },
    caps: { perCall: 10, daily: 100, unsettled: 500, ...caps },
    usage: { spentToday: 23, notYetCharged: 20, notYetChargedCalls: 4, spentTotal: 60, ...usage },
    remainingToday: 77,
    blocked: false,
    blockReason: null,
    ...rest,
  };
}

describe('formatStatus', () => {
  it('prints the lines of the design spec, with a last charge', () => {
    const lines = formatStatus(
      status({ wallet: { lastChargeAt: 1_793_109_900, lastChargeAmount: 8, lastChargeStatus: 'completed' } }),
      'http://localhost:4021',
    );
    expect(lines).toEqual([
      'Agent        research-bot  ed25519:Ab3dE9wXyz  for Northwind Research',
      'State        Ready to pay',
      'Limits       $0.10 per call, $1.00 per day, $5.00 not yet charged, no total limit',
      'Today        $0.23 spent, $0.77 left (this agent: $0.15 in 3 calls)',
      'Not charged  $0.20 in 4 calls',
      'PayPal       Linked. Last charge $0.08, completed, 2026-10-27 14:05 UTC',
      'Seller       http://localhost:4021',
    ]);
  });

  it('shows a total limit when there is one, and singular call counts', () => {
    const lines = formatStatus(
      status({ caps: { total: 5000 }, agent: { callsToday: 1 }, usage: { notYetChargedCalls: 1 } }),
      'http://localhost:4021',
    );
    expect(lines[2]).toBe('Limits       $0.10 per call, $1.00 per day, $5.00 not yet charged, $50.00 total');
    expect(lines[3]).toContain('(this agent: $0.15 in 1 call)');
    expect(lines[4]).toBe('Not charged  $0.20 in 1 call');
  });

  it('prints zero amounts and no last charge for a fresh agent', () => {
    const lines = formatStatus(
      status({ agent: { spentToday: 0, callsToday: 0 }, usage: { spentToday: 0, notYetCharged: 0, notYetChargedCalls: 0 }, remainingToday: 100 }),
      'http://seller.test',
    );
    expect(lines[3]).toBe('Today        $0.00 spent, $1.00 left (this agent: $0.00 in 0 calls)');
    expect(lines[4]).toBe('Not charged  $0.00 in 0 calls');
    expect(lines[5]).toBe('PayPal       Linked');
  });

  it('writes a needs_review charge as words, and uses the wallet wording when not linked', () => {
    const lines = formatStatus(
      status({ wallet: { status: 'stopped_by_payer', lastChargeAt: 1_793_109_900, lastChargeAmount: 120, lastChargeStatus: 'needs_review' } }),
      'http://seller.test',
    );
    expect(lines[5]).toBe('PayPal       PayPal stopped by the payer. Last charge $1.20, needs review, 2026-10-27 14:05 UTC');
  });

  it('is ASCII only', () => {
    for (const line of formatStatus(status(), 'http://seller.test')) expect(line).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe('stateOf', () => {
  it('puts a paused agent first, even when the wallet is stopped', () => {
    expect(stateOf(status({ agent: { status: 'paused' }, blocked: true, blockReason: 'wallet_not_active', wallet: { status: 'stopped_by_payer' } }))).toBe(
      'Paused by the operator',
    );
  });

  it.each([
    ['stopped_by_payer', 'PayPal stopped by the payer'],
    ['not_linked', 'PayPal not linked'],
    ['link_failed', 'PayPal not linked'],
    ['waiting_for_approval', 'Waiting for PayPal approval'],
    ['unlinking', 'PayPal is being unlinked'],
  ])('words a %s wallet as "%s"', (walletStatus, wording) => {
    expect(stateOf(status({ blocked: true, blockReason: 'wallet_not_active', wallet: { status: walletStatus } }))).toBe(wording);
    expect(walletWording(walletStatus)).toBe(wording);
  });

  it.each([
    ['daily', 'Daily limit reached'],
    ['unsettled', 'Waiting for a PayPal charge (not-yet-charged limit reached)'],
    ['total', 'Total limit reached'],
  ])('words the %s cap as "%s"', (reason, wording) => {
    expect(stateOf(status({ blocked: true, blockReason: reason }))).toBe(wording);
  });

  it('is ready otherwise', () => {
    expect(stateOf(status())).toBe('Ready to pay');
  });
});

describe('formatUtc', () => {
  it('prints UTC to the minute', () => {
    expect(formatUtc(0)).toBe('1970-01-01 00:00 UTC');
    expect(formatUtc(1_792_152_000)).toBe('2026-10-16 12:00 UTC');
    expect(formatUtc(1_792_152_059)).toBe('2026-10-16 12:00 UTC');
  });
});
