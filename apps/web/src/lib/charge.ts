/**
 * "Charge now" and the unlink dialog (design spec §10.7, §10.12). Both use `chargeable`, never
 * `notYetCharged`: calls held by a `needs_review` settlement stay `settling` and cannot be claimed.
 */
import { formatUsd } from './money';

export interface ChargeInput {
  wallet: { status: string };
  usage: { chargeable: number; chargeableCalls: number };
  lastSettlement: { status: string } | null;
}

export interface ChargeNow {
  enabled: boolean;
  amount: number;
  calls: number;
  title: string;
  body: string;
}

export function chargeNow(view: ChargeInput): ChargeNow {
  const amount = view.usage.chargeable;
  const calls = view.usage.chargeableCalls;
  return {
    enabled: view.wallet.status === 'active' && amount > 0 && view.lastSettlement?.status !== 'pending',
    amount,
    calls,
    title: `Charge ${formatUsd(amount)} to your PayPal account now?`,
    body: `This covers ${calls} paid call${calls === 1 ? '' : 's'} that ${calls === 1 ? 'is' : 'are'} not yet charged. It is one PayPal charge, so one fee.`,
  };
}

/** The toast after a 201 (design spec §10.7). */
export function chargeToast(status: string): string {
  return status === 'completed' ? 'PayPal charge completed' : 'PayPal charge started';
}

export interface UnlinkCopy {
  button: string;
  text: string;
  disabled: boolean;
  tooltip: string | undefined;
}

export function unlinkCopy(chargeable: number, lastSettlementStatus: string | undefined): UnlinkCopy {
  const pending = lastSettlementStatus === 'pending';
  return {
    button: chargeable > 0 ? `Charge ${formatUsd(chargeable)} and unlink` : 'Unlink',
    text:
      chargeable > 0
        ? `All agents are refused within a minute. Paid calls not yet charged (${formatUsd(chargeable)}) are charged now, one last time.`
        : 'All agents are refused within a minute.',
    disabled: pending,
    tooltip: pending ? 'A PayPal charge is running. Try again when it finishes.' : undefined,
  };
}

export interface ChargeNote {
  title: string;
  text: string;
  kind: 'charging' | 'declined' | 'review';
  role: 'status' | 'alert';
}

/** The note of a charge detail (design spec §10.9, fixes §2.12). */
export function chargeNote(s: { status: string; failureCode: string | null; failureReason: string | null; callsCount: number }): ChargeNote | undefined {
  const calls = `${s.callsCount} paid call${s.callsCount === 1 ? '' : 's'}`;
  if (s.status === 'pending') return { title: 'Charging…', text: 'PayPal is processing this charge.', kind: 'charging', role: 'status' };
  if (s.status === 'needs_review') {
    return { title: 'Needs review', text: "We couldn't confirm this charge with PayPal. It is under review. The calls in it will not be charged twice.", kind: 'review', role: 'status' };
  }
  if (s.status !== 'failed') return undefined;
  if (s.failureCode === 'payer_stopped') {
    return {
      title: 'Failure reason: You stopped the agreement in your PayPal account.',
      text: `These ${calls} were not charged. They are marked Not collected and are charged first when you re-link.`,
      kind: 'declined',
      role: 'alert',
    };
  }
  if (s.failureCode === 'declined') {
    return {
      title: 'Failure reason: PayPal declined the charge.',
      text: `These ${calls} went back to Not yet charged and will be part of the next charge.`,
      kind: 'declined',
      role: 'alert',
    };
  }
  return { title: `Failure reason: ${s.failureReason ?? 'The charge failed.'}`, text: `These ${calls} were not charged by this attempt.`, kind: 'declined', role: 'alert' };
}
