/** The overview banner (design spec §10.7): at most one, the first that applies. */
import { formatUsd } from './money';
import { formatDateTime } from './time';

export interface BannerInput {
  wallet: { status: string };
  caps: { daily: number };
  usage: { notCollected: number; spentTotal: number; notYetCharged: number };
  lastSettlement: { id: string; trigger: string; status: string; amount: number; createdAt: number; failureCode: string | null } | null;
  blockReason: string | null;
}

export type Banner =
  | { kind: 'stopped'; text: string }
  | { kind: 'unlinking'; text: string }
  | { kind: 'collecting'; text: string }
  | { kind: 'not_linked'; text: string }
  | { kind: 'declined'; text: string; settlementId: string }
  | { kind: 'review'; text: string; settlementId: string }
  | { kind: 'daily'; text: string }
  | { kind: 'total'; text: string }
  | { kind: 'unsettled'; text: string };

export function pickBanner(view: BannerInput): Banner | undefined {
  const { wallet, usage, lastSettlement: last } = view;
  if (wallet.status === 'stopped_by_payer') {
    return {
      kind: 'stopped',
      text: `Your PayPal agreement was stopped. Agents are blocked. Re-link to resume.${usage.notCollected > 0 ? ` ${formatUsd(usage.notCollected)} of earlier usage will be charged first.` : ''}`,
    };
  }
  if (wallet.status === 'unlinking') {
    const amount = last?.trigger === 'unlink' && last.status === 'pending' ? ` of ${formatUsd(last.amount)}` : '';
    return { kind: 'unlinking', text: `The final charge${amount} is still processing. Your account unlinks when it completes.` };
  }
  if (wallet.status === 'waiting_for_approval' && last?.trigger === 'relink' && last.status === 'pending') {
    return {
      kind: 'collecting',
      text: `Linked. Collecting ${formatUsd(last.amount)} of usage from before you stopped… Agents can pay again once this charge completes.`,
    };
  }
  if (wallet.status === 'not_linked' || wallet.status === 'link_failed' || wallet.status === 'waiting_for_approval') {
    return { kind: 'not_linked', text: "Agents can't pay until you link one." };
  }
  if (last?.status === 'failed' && last.failureCode === 'declined') {
    return {
      kind: 'declined',
      text: `PayPal declined the ${formatUsd(last.amount)} charge on ${formatDateTime(last.createdAt)}. The calls went back to Not yet charged; we try again in 15 minutes.`,
      settlementId: last.id,
    };
  }
  if (last?.status === 'needs_review') {
    return {
      kind: 'review',
      text: `We couldn't confirm the ${formatUsd(last.amount)} charge on ${formatDateTime(last.createdAt)} with PayPal. It is under review, and those calls will not be charged twice.`,
      settlementId: last.id,
    };
  }
  if (view.blockReason === 'daily') {
    return { kind: 'daily', text: `Agents spent ${formatUsd(view.caps.daily)} today. New paid calls are refused until midnight UTC.` };
  }
  if (view.blockReason === 'total') {
    return { kind: 'total', text: `Agents spent ${formatUsd(usage.spentTotal)} in total. Raise the total limit in Settings to let them pay again.` };
  }
  if (view.blockReason === 'unsettled') {
    return { kind: 'unsettled', text: `Unpaid usage reached ${formatUsd(usage.notYetCharged)}. Agents pay again once the charge completes.` };
  }
  return undefined;
}
