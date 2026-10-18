/**
 * The PayPal link state of onboarding step 1 and the return page (design spec §10.3, §10.13), as
 * one pure function of `GET /v1/operator`.
 */
import { formatUsd } from './money';

export interface LinkInput {
  wallet: { status: string; payerEmailMasked: string | null; linkError: string | null };
  usage: { notCollected: number };
  lastSettlement: { trigger: string; status: string; amount: number } | null;
}

export type LinkState =
  | { kind: 'ready'; earlierUsage: number }
  | { kind: 'waiting' }
  | { kind: 'collecting'; amount: number }
  | { kind: 'collecting_review'; amount: number }
  | { kind: 'linked'; email: string | null }
  | { kind: 'unlinking' }
  | { kind: 'failed'; reason: string; notCollected: number };

export function linkState(input: LinkInput): LinkState {
  const { wallet, usage, lastSettlement } = input;
  switch (wallet.status) {
    case 'not_linked':
      return { kind: 'ready', earlierUsage: 0 };
    case 'stopped_by_payer':
      return { kind: 'ready', earlierUsage: usage.notCollected };
    case 'waiting_for_approval':
      if (lastSettlement?.trigger === 'relink' && lastSettlement.status === 'pending') return { kind: 'collecting', amount: lastSettlement.amount };
      if (lastSettlement?.trigger === 'relink' && lastSettlement.status === 'needs_review') {
        return { kind: 'collecting_review', amount: lastSettlement.amount };
      }
      return { kind: 'waiting' };
    case 'active':
      return { kind: 'linked', email: wallet.payerEmailMasked };
    case 'unlinking':
      return { kind: 'unlinking' };
    default:
      return { kind: 'failed', reason: wallet.linkError ?? 'unknown', notCollected: usage.notCollected };
  }
}

/** The Collecting states never call `/refresh`; only Waiting polls it (design spec §10.3). */
export function pollsRefresh(state: LinkState): boolean {
  return state.kind === 'waiting';
}

/** The Collecting states re-read the operator every 3 s instead. */
export function rereadsOperator(state: LinkState): boolean {
  return state.kind === 'collecting';
}

/**
 * What the Waiting state does with a `/refresh` answer: a 409 `settlement_in_progress` means the
 * approval just finished and a relink was claimed, so the page refreshes into Collecting, with no
 * toast. Other errors show their copy.
 */
export function refreshOutcome(result: { ok: true; status: string } | { ok: false; error: string }): 'refresh' | 'keep_polling' | 'toast' {
  if (result.ok) return result.status === 'waiting_for_approval' ? 'keep_polling' : 'refresh';
  if (result.error === 'settlement_in_progress') return 'refresh';
  return 'toast';
}

/** The failure reason copy (fixes §2.3). */
export function failText(reason: string, notCollected: number): string {
  if (reason === 'cancelled') return 'You cancelled on PayPal.';
  if (reason === 'expired') return 'The approval link expired after 3 days.';
  if (reason === 'relink_settlement_failed') {
    return `We couldn't collect the ${formatUsd(notCollected)} left from before you stopped. Try again, or link a different PayPal account.`;
  }
  return 'Linking did not complete. Try again.';
}

export const COLLECTING_REVIEW_TEXT =
  "Linked, but we couldn't confirm the charge for your earlier usage with PayPal. It is under review, and it will not be charged twice. Agents stay paused until it clears.";

/** The return page's card (design spec §10.13). Unexpected status values are `unknown`. */
export type ReturnCard = 'active' | 'waiting' | 'link_failed' | 'unknown';

export function returnCard(status: string | undefined): ReturnCard {
  if (status === 'active') return 'active';
  if (status === 'waiting_for_approval') return 'waiting';
  if (status === 'link_failed') return 'link_failed';
  return 'unknown';
}
