import { describe, expect, it } from 'vitest';
import { capsToInput, issuesToFields, previewSentence, validateCaps, type CapsInput } from './caps-form';
import { chargeNow, chargeToast, unlinkCopy } from './charge';
import { COLLECTING_REVIEW_TEXT, failText, linkState, pollsRefresh, refreshOutcome, rereadsOperator, returnCard, type LinkInput } from './link-state';
import { agentNameError, envFile } from './key-files';

const base: CapsInput = { perCall: '0.10', daily: '10.00', total: '50.00', noTotal: false, autoCharge: '5.00' };

describe('caps-form', () => {
  it('accepts valid limits and sends all four fields, with total null for no total limit', () => {
    expect(validateCaps(base)).toEqual({ ok: true, caps: { perCall: 10, daily: 1000, unsettled: 500, total: 5000 } });
    expect(validateCaps({ ...base, noTotal: true, total: 'nonsense' })).toEqual({ ok: true, caps: { perCall: 10, daily: 1000, unsettled: 500, total: null } });
    expect(validateCaps({ ...base, perCall: '$0.1', daily: '1,000' })).toMatchObject({ ok: true, caps: { perCall: 10, daily: 100000 } });
  });

  it('checks the format, the two decimals and the $10,000.00 ceiling', () => {
    expect(validateCaps({ ...base, daily: '' })).toMatchObject({ ok: false, errors: { daily: 'Enter an amount.' } });
    expect(validateCaps({ ...base, daily: '1.234' })).toMatchObject({ ok: false, errors: { daily: 'Use a dollar amount with at most 2 decimals, like 5.00.' } });
    expect(validateCaps({ ...base, daily: '-1' })).toMatchObject({ ok: false });
    expect(validateCaps({ ...base, daily: '10000.01' })).toMatchObject({ ok: false, errors: { daily: 'The most you can set is $10,000.00.' } });
    expect(validateCaps({ ...base, daily: '10000.00' }).ok).toBe(true);
  });

  it('applies every rule with its message', () => {
    expect(validateCaps({ ...base, perCall: '0.00' })).toMatchObject({ ok: false, errors: { perCall: 'Max per call must be at least $0.01' } });
    expect(validateCaps({ ...base, perCall: '11.00', total: '20.00', autoCharge: '20.00' })).toMatchObject({
      ok: false,
      errors: { perCall: "Max per call can't be higher than the daily limit" },
    });
    expect(validateCaps({ ...base, perCall: '6.00' })).toMatchObject({ ok: false, errors: { perCall: "Max per call can't be higher than Auto-charge at" } });
    expect(validateCaps({ ...base, perCall: '0.10', total: '0.05' })).toMatchObject({ ok: false, errors: { total: "The total limit can't be lower than Max per call" } });
  });

  it('maps facilitator issues to fields, prefills from saved caps, and writes the preview', () => {
    expect(issuesToFields([{ path: 'unsettled', message: 'unsettled must be at least perCall' }, { path: '', message: 'bad' }])).toEqual({
      autoCharge: 'unsettled must be at least perCall',
      perCall: 'bad',
    });
    expect(capsToInput({ perCall: 10, daily: 1000, unsettled: 500 })).toEqual({ perCall: '0.10', daily: '10.00', total: '', noTotal: true, autoCharge: '5.00' });
    expect(capsToInput({ perCall: 10, daily: 1000, unsettled: 500, total: 5000 }).total).toBe('50.00');
    expect(previewSentence({ perCall: 10, daily: 1000, unsettled: 500, total: null })).toBe(
      'Your agents can spend up to $10.00 a day. We charge your PayPal account when unpaid usage nears $5.00, and at least once a day.',
    );
  });
});

const view = (wallet: Partial<LinkInput['wallet']> & { status: string }, extra: Partial<LinkInput> = {}): LinkInput => ({
  wallet: { payerEmailMasked: null, linkError: null, ...wallet },
  usage: { notCollected: 0 },
  lastSettlement: null,
  ...extra,
});

describe('link state (design spec §10.3)', () => {
  it('maps every row of the table', () => {
    expect(linkState(view({ status: 'not_linked' }))).toEqual({ kind: 'ready', earlierUsage: 0 });
    expect(linkState(view({ status: 'waiting_for_approval' }))).toEqual({ kind: 'waiting' });
    expect(linkState(view({ status: 'waiting_for_approval' }, { lastSettlement: { trigger: 'manual', status: 'pending', amount: 9 } }))).toEqual({ kind: 'waiting' });
    expect(linkState(view({ status: 'waiting_for_approval' }, { lastSettlement: { trigger: 'relink', status: 'pending', amount: 312 } }))).toEqual({
      kind: 'collecting',
      amount: 312,
    });
    expect(linkState(view({ status: 'waiting_for_approval' }, { lastSettlement: { trigger: 'relink', status: 'needs_review', amount: 312 } }))).toEqual({
      kind: 'collecting_review',
      amount: 312,
    });
    expect(linkState(view({ status: 'active', payerEmailMasked: 'bu***@example.com' }))).toEqual({ kind: 'linked', email: 'bu***@example.com' });
    expect(linkState(view({ status: 'link_failed', linkError: 'expired' }, { usage: { notCollected: 0 } }))).toEqual({ kind: 'failed', reason: 'expired', notCollected: 0 });
    expect(linkState(view({ status: 'stopped_by_payer' }, { usage: { notCollected: 312 } }))).toEqual({ kind: 'ready', earlierUsage: 312 });
  });

  it('writes the failure reasons of fixes §2.3', () => {
    expect(failText('cancelled', 0)).toBe('You cancelled on PayPal.');
    expect(failText('expired', 0)).toBe('The approval link expired after 3 days.');
    expect(failText('relink_settlement_failed', 312)).toBe(
      "We couldn't collect the $3.12 left from before you stopped. Try again, or link a different PayPal account.",
    );
    expect(COLLECTING_REVIEW_TEXT).toContain('it will not be charged twice');
  });

  it('gives payment_token_failed the generic failure copy (design spec §10.3)', () => {
    expect(failText('payment_token_failed', 0)).toBe('Linking did not complete. Try again.');
    expect(linkState(view({ status: 'link_failed', linkError: 'payment_token_failed' }, { usage: { notCollected: 0 } }))).toEqual({
      kind: 'failed',
      reason: 'payment_token_failed',
      notCollected: 0,
    });
  });

  it('never polls /refresh in the Collecting states', () => {
    expect(pollsRefresh({ kind: 'waiting' })).toBe(true);
    expect(pollsRefresh({ kind: 'collecting', amount: 1 })).toBe(false);
    expect(pollsRefresh({ kind: 'collecting_review', amount: 1 })).toBe(false);
    expect(rereadsOperator({ kind: 'collecting', amount: 1 })).toBe(true);
    expect(rereadsOperator({ kind: 'collecting_review', amount: 1 })).toBe(false);
  });

  it('treats a 409 settlement_in_progress from /refresh as "now collecting": no toast, a refresh', () => {
    expect(refreshOutcome({ ok: false, error: 'settlement_in_progress' })).toBe('refresh');
    expect(refreshOutcome({ ok: true, status: 'waiting_for_approval' })).toBe('keep_polling');
    expect(refreshOutcome({ ok: true, status: 'active' })).toBe('refresh');
    expect(refreshOutcome({ ok: false, error: 'paypal_unavailable' })).toBe('toast');
    // The next read lands in Collecting.
    expect(linkState(view({ status: 'waiting_for_approval' }, { lastSettlement: { trigger: 'relink', status: 'pending', amount: 5 } })).kind).toBe('collecting');
  });

  it('picks the return page card, treating unexpected values as unknown', () => {
    expect(returnCard('active')).toBe('active');
    expect(returnCard('waiting_for_approval')).toBe('waiting');
    expect(returnCard('link_failed')).toBe('link_failed');
    for (const other of ['unknown', 'stopped_by_payer', 'unlinking', 'not_linked', undefined, '<script>']) expect(returnCard(other)).toBe('unknown');
  });
});

describe('charge and unlink amounts', () => {
  const active = { wallet: { status: 'active' }, lastSettlement: null };
  it('uses chargeable and chargeableCalls, and disables Charge now at 0 even when notYetCharged is not', () => {
    expect(chargeNow({ ...active, usage: { chargeable: 312, chargeableCalls: 104 } })).toMatchObject({
      enabled: true,
      title: 'Charge $3.12 to your PayPal account now?',
      body: 'This covers 104 paid calls that are not yet charged. It is one PayPal charge, so one fee.',
    });
    expect(chargeNow({ ...active, usage: { chargeable: 0, chargeableCalls: 0 } }).enabled).toBe(false);
    expect(chargeNow({ wallet: { status: 'stopped_by_payer' }, lastSettlement: null, usage: { chargeable: 5, chargeableCalls: 1 } }).enabled).toBe(false);
    expect(chargeNow({ ...active, lastSettlement: { status: 'pending' }, usage: { chargeable: 5, chargeableCalls: 1 } }).enabled).toBe(false);
    expect(chargeToast('completed')).toBe('PayPal charge completed');
    expect(chargeToast('pending')).toBe('PayPal charge started');
  });

  it('writes the unlink dialog from chargeable, and disables Unlink while a charge is pending', () => {
    expect(unlinkCopy(312, 'completed')).toEqual({
      button: 'Charge $3.12 and unlink',
      text: 'All agents are refused within a minute. Paid calls not yet charged ($3.12) are charged now, one last time.',
      disabled: false,
      tooltip: undefined,
    });
    expect(unlinkCopy(0, undefined)).toMatchObject({ button: 'Unlink', text: 'All agents are refused within a minute.' });
    expect(unlinkCopy(5, 'pending')).toMatchObject({ disabled: true, tooltip: 'A PayPal charge is running. Try again when it finishes.' });
  });
});

describe('agent key files', () => {
  it('validates names and writes the .env with AGENT_PRIVATE_KEY', () => {
    expect(agentNameError('research-bot')).toBeUndefined();
    expect(agentNameError('Research')).toBe('Use lowercase letters, digits and dashes.');
    expect(agentNameError('-bot')).toBeDefined();
    expect(agentNameError('a'.repeat(41))).toBeDefined();
    expect(envFile('research-bot', 'SEED')).toBe('# .env for research-bot\nAGENT_PRIVATE_KEY=SEED\n');
  });
});
