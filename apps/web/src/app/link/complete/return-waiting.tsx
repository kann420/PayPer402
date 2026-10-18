'use client';

import { useCollectingReread, useWaitingPoll } from '@/components/onboarding/link-panel';
import { LiveRefresh } from '@/components/live/live-refresh';
import { COLLECTING_REVIEW_TEXT } from '@/lib/link-state';
import { formatUsd } from '@/lib/money';

export type ReturnWaitingState = { kind: 'waiting' } | { kind: 'collecting'; amount: number } | { kind: 'collecting_review'; amount: number };

/** `status=waiting_for_approval` on the return page: Still waiting, Collecting, or needs review. */
export function ReturnWaiting({ state }: { state: ReturnWaitingState }) {
  const { checkNow, checking } = useWaitingPoll(state.kind === 'waiting');
  useCollectingReread(state.kind === 'collecting');
  const icon = 'inline-flex size-12 items-center justify-center rounded-[14px]';

  if (state.kind === 'waiting') {
    return (
      <section className="pg-enter flex w-full max-w-[460px] flex-col gap-3.5 rounded-[20px] border border-line-200 bg-white p-6">
        <span className={`${icon} bg-violet-100 text-violet-800`}>
          <svg className="pg-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9" />
          </svg>
        </span>
        <strong className="text-[19px]">Still waiting for PayPal</strong>
        <p role="status" className="m-0 text-sm text-ink-800">
          PayPal hasn&apos;t confirmed the approval yet. This page checks again by itself.
        </p>
        {/* Asks PayPal through /refresh at once and restarts the poll window (design spec §10.13). */}
        <button
          type="button"
          disabled={checking}
          aria-busy={checking}
          onClick={checkNow}
          className="mt-auto self-start rounded-[10px] border-[1.5px] border-line-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-70"
        >
          Check again
        </button>
      </section>
    );
  }
  return (
    <section className="pg-enter flex w-full max-w-[460px] flex-col gap-3.5 rounded-[20px] border border-line-200 bg-white p-6">
      <LiveRefresh scope="operator" />
      <span className={`${icon} ${state.kind === 'collecting' ? 'bg-meter-100 text-meter-800' : 'bg-amber-100 text-amber-800'}`}>
        {state.kind === 'collecting' ? (
          <svg className="pg-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4M11 8v3M11 14h.01" />
          </svg>
        )}
      </span>
      {state.kind === 'collecting' ? (
        <>
          <strong className="text-[19px]">
            Linked. Collecting <span className="font-mono">{formatUsd(state.amount)}</span> of usage from before you stopped…
          </strong>
          <p role="status" className="m-0 text-sm text-ink-800">
            Agents can pay again once this charge completes.
          </p>
        </>
      ) : (
        <>
          <strong className="text-[19px]">Charge under review</strong>
          <p role="status" className="m-0 text-sm text-ink-800">
            {COLLECTING_REVIEW_TEXT}
          </p>
        </>
      )}
    </section>
  );
}
