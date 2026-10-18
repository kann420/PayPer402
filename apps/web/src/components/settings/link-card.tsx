'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { unlinkCopy } from '@/lib/charge';
import { errorCopy } from '@/lib/copy';
import { formatUsd } from '@/lib/money';
import { statusEntry } from '@/lib/status';
import { formatDate, formatDateTime } from '@/lib/time';
import { callApi, handleEnded } from '../shell/session-client';
import { useFocusTrap } from '../ui/dialog';
import { StatusBadge } from '../ui/status-badge';
import { useToast } from '../ui/toast';

export interface LinkCardProps {
  wallet: { status: string; payerEmailMasked: string | null; linkedAt: number | null; stoppedAt: number | null; lastChargeAt: number | null; lastChargeAmount: number | null };
  chargeable: number;
  notCollected: number;
  lastSettlement: { trigger: string; status: string; amount: number } | null;
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2BE38A" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

export const UNLINK_REVIEW_TEXT =
  "We couldn't confirm the final charge with PayPal. It is under review, and it will not be charged twice. Your account unlinks once it clears.";

/** The PayPal link card of Settings (design spec §10.12, fixes §2.13). */
export function LinkCard({ wallet, chargeable, notCollected, lastSettlement }: LinkCardProps) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const closeConfirm = useCallback(() => setConfirm(false), []);
  const status = wallet.status;
  const copy = unlinkCopy(chargeable, lastSettlement?.status);
  const unlinkReview = status === 'unlinking' && lastSettlement?.trigger === 'unlink' && lastSettlement.status === 'needs_review';

  // The inline confirm is a modal step (design spec §16): focus moves in, Tab stays inside, Escape
  // closes it, and focus returns to "Unlink" afterwards.
  useFocusTrap(confirmRef, confirm && status === 'active', closeConfirm);

  const unlink = async () => {
    setBusy(true);
    const res = await callApi<{ wallet: { status: string } }>('/api/operator/wallet/unlink');
    setBusy(false);
    setConfirm(false);
    if (res.ok) {
      toast({ text: 'PayPal account unlinked' });
    } else if (handleEnded(res)) {
      return;
    } else if (res.error === 'settlement_failed') {
      setDeclined(true);
    } else if (res.error !== 'settlement_in_progress') {
      toast({ text: errorCopy(res.error, res.message), icon: 'error' });
    }
    router.refresh();
  };

  const sub =
    status === 'stopped_by_payer'
      ? `You stopped automatic payments in PayPal. Agents are refused until you re-link.${notCollected > 0 ? ` ${formatUsd(notCollected)} of earlier usage will be charged first.` : ''}`
      : status === 'unlinking'
        ? unlinkReview
          ? UNLINK_REVIEW_TEXT
          : `Charging ${formatUsd(lastSettlement?.trigger === 'unlink' ? lastSettlement.amount : chargeable)} of usage not yet charged, one last time. Agents are refused.`
        : status === 'not_linked'
          ? 'Link a PayPal account so your agents can pay for calls.'
          : status === 'waiting_for_approval'
            ? 'Linking is waiting for your approval on PayPal.'
            : status === 'link_failed'
              ? 'The last link did not complete.'
              : '';

  const linkedish = status === 'active' || status === 'unlinking' || status === 'stopped_by_payer';
  return (
    <section className="flex flex-col gap-[18px] rounded-2xl border border-line-200 bg-white p-6">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <h2 className="m-0 text-lg">PayPal link</h2>
        <StatusBadge entry={statusEntry('wallet', status)} />
      </div>
      {sub === '' ? null : <p className="m-0 text-sm text-ink-800">{sub}</p>}
      {linkedish ? (
        <dl className="m-0 grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]">
          <div>
            <dt className="text-[13px] text-ink-500">PayPal account</dt>
            <dd className="m-0 mt-0.5 font-mono">{wallet.payerEmailMasked ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink-500">{status === 'stopped_by_payer' ? 'Stopped' : 'Linked since'}</dt>
            <dd className="tnum m-0 mt-0.5 font-mono">
              {status === 'stopped_by_payer'
                ? wallet.stoppedAt === null
                  ? '—'
                  : formatDateTime(wallet.stoppedAt)
                : wallet.linkedAt === null
                  ? '—'
                  : formatDate(wallet.linkedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink-500">Last charge</dt>
            <dd className="tnum m-0 mt-0.5 font-mono">
              {wallet.lastChargeAmount === null || wallet.lastChargeAt === null
                ? '—'
                : `${formatUsd(wallet.lastChargeAmount)} · ${formatDateTime(wallet.lastChargeAt)}`}
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="flex flex-wrap items-center gap-2.5">
        {status === 'active' ? (
          <span className="inline-flex" title={copy.tooltip}>
            <button
              type="button"
              disabled={copy.disabled || busy}
              onClick={() => {
                setDeclined(false);
                setConfirm(true);
              }}
              className="h-11 rounded-[10px] border-[1.5px] border-red-700 bg-white px-4 font-semibold text-red-700 disabled:cursor-not-allowed disabled:border-line-250 disabled:bg-ground-50 disabled:text-[#7A837E]"
            >
              Unlink
            </button>
          </span>
        ) : null}
        {status === 'unlinking' ? (
          <>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-[10px] border-[1.5px] border-line-250 bg-ground-50 px-4 font-semibold text-[#7A837E]"
            >
              <span aria-hidden="true" className="pg-spin size-3.5 rounded-full border-2 border-line-300 border-t-violet-800" />
              Unlinking…
            </button>
            {unlinkReview ? null : <span className="text-sm text-ink-800">Your account unlinks when the final charge completes.</span>}
          </>
        ) : null}
        {status === 'stopped_by_payer' ? (
          <Link href="/app/onboarding/link" className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-ink-950 px-[18px] font-semibold text-white hover:text-white">
            <LinkIcon />
            Re-link PayPal account
          </Link>
        ) : null}
        {status === 'not_linked' || status === 'link_failed' || status === 'waiting_for_approval' ? (
          <Link href="/app/onboarding/link" className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-ink-950 px-[18px] font-semibold text-white hover:text-white">
            <LinkIcon />
            Link PayPal account
          </Link>
        ) : null}
      </div>
      {declined ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border-[1.5px] border-red-700 bg-red-100 px-3.5 py-3 text-sm font-semibold text-red-800">
          <span className="mt-0.5 inline-flex flex-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v6M12 17h.01" />
            </svg>
          </span>
          The final charge was declined, so your PayPal account stays linked. Try again later.
        </div>
      ) : null}
      <p className="m-0 flex items-start gap-2 text-sm text-ink-700">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="mt-0.5 flex-none">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
        <span>You can also stop at any time from your PayPal account (Settings → Automatic payments). Agents are refused within a minute.</span>
      </p>
      {confirm && status === 'active' ? (
        <div ref={confirmRef} role="alertdialog" aria-modal="true" aria-labelledby="unlink-title" aria-describedby="unlink-text" className="pg-dialog flex flex-col gap-3 rounded-[14px] border-[1.5px] border-red-700 bg-[#FFF8F7] p-5">
          <strong id="unlink-title" className="text-base">
            Unlink your PayPal account?
          </strong>
          <p id="unlink-text" className="m-0 text-sm text-ink-800">
            {copy.text}
          </p>
          <div className="flex flex-wrap gap-2.5">
            <button type="button" disabled={busy} onClick={() => void unlink()} className="h-[42px] rounded-[10px] border-0 bg-red-700 px-4 font-semibold text-white disabled:opacity-70">
              {copy.button}
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="h-[42px] rounded-[10px] border border-line-300 bg-white px-4 font-semibold">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
