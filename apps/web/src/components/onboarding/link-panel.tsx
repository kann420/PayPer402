'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorCopy } from '@/lib/copy';
import { COLLECTING_REVIEW_TEXT, failText, refreshOutcome, type LinkState } from '@/lib/link-state';
import { formatUsd } from '@/lib/money';
import { WaitingPoll } from '@/lib/waiting-poll';
import { LiveRefresh } from '../live/live-refresh';
import { callApi, handleEnded, type ApiResult } from '../shell/session-client';
import { useToast } from '../ui/toast';

const POLL_MS = 3000;
const WAIT_LIMIT_MS = 10 * 60 * 1000;

function Spinner({ size = 22 }: { size?: number }) {
  return (
    <svg className="pg-spin flex-none" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2BE38A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

/** Starts linking: a 1 s "Redirecting to PayPal…" hand-off, then PayPal's page in the same tab. */
export function useStartLink(): { start: () => Promise<void>; busy: boolean; handoff: boolean } {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    const res = await callApi<{ approveUrl: string; expiresAt: number }>('/api/operator/wallet/link');
    if (!res.ok) {
      setBusy(false);
      if (!handleEnded(res)) toast({ text: errorCopy(res.error, res.message), icon: 'error' });
      return;
    }
    setHandoff(true);
    const url = res.approveUrl;
    window.setTimeout(() => window.location.assign(url), 1000);
  };
  return { start, busy, handoff };
}

export function Handoff() {
  return (
    <div role="status" className="pg-fade fixed inset-0 z-[95] flex flex-col items-center justify-center gap-4 bg-ink-950 text-dark-text">
      <Spinner size={32} />
      <strong className="text-xl">Redirecting to PayPal…</strong>
      <span className="text-sm text-dark-muted">Approve on PayPal&apos;s page, then you come back here.</span>
    </div>
  );
}

/**
 * Polls `/refresh` every 3 s for up to 10 minutes while waiting (design spec §10.3). `checkNow` is
 * the return page's "Check again" (§10.13): it asks at once and restarts the window, and
 * `checking` is true while its request runs. The scheduling lives in `WaitingPoll`.
 */
export function useWaitingPoll(active: boolean): { checkNow: () => void; checking: boolean } {
  const router = useRouter();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const poll = useRef<WaitingPoll<ApiResult<{ wallet: { status: string } }>> | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    const current = new WaitingPoll<ApiResult<{ wallet: { status: string } }>>({
      request: () => callApi<{ wallet: { status: string } }>('/api/operator/wallet/refresh'),
      apply: (res) => {
        if (!res.ok && handleEnded(res)) return false;
        const outcome = refreshOutcome(res.ok ? { ok: true, status: res.wallet.status } : { ok: false, error: res.error });
        if (outcome === 'refresh') {
          router.refresh();
          return false;
        }
        if (outcome === 'toast' && !res.ok) toast({ text: errorCopy(res.error, res.message), icon: 'error' });
        return true;
      },
      onChecking: setChecking,
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle),
      now: () => Date.now(),
      intervalMs: POLL_MS,
      limitMs: WAIT_LIMIT_MS,
    });
    poll.current = current;
    current.start();
    return () => {
      current.dispose();
      if (poll.current === current) poll.current = undefined;
    };
  }, [active, router, toast]);
  const checkNow = useCallback(() => poll.current?.checkNow(), []);
  return { checkNow, checking };
}

/** Collecting re-reads the operator every 3 s through `router.refresh()`, never `/refresh`. */
export function useCollectingReread(active: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);
}

/** The state block of onboarding step 1 (board `OnbLink` and its variants). */
export function LinkPanel({ state }: { state: LinkState }) {
  const { start, busy, handoff } = useStartLink();
  useWaitingPoll(state.kind === 'waiting');
  useCollectingReread(state.kind === 'collecting');
  const listens = state.kind === 'collecting' || state.kind === 'collecting_review';

  return (
    <>
      {handoff ? <Handoff /> : null}
      {listens ? <LiveRefresh scope="operator" /> : null}
      {state.kind === 'ready' ? (
        <div className="flex flex-col gap-3">
          {state.earlierUsage > 0 ? (
            <p className="m-0 text-sm text-ink-800">
              <span className="font-mono">{formatUsd(state.earlierUsage)}</span> of earlier usage will be charged first.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void start()}
              className="inline-flex min-h-12 items-center gap-2.5 rounded-xl border-0 bg-ink-950 px-[22px] py-[15px] text-base font-semibold text-white disabled:opacity-70"
            >
              <LinkIcon />
              Link PayPal account
            </button>
            <span className="inline-flex items-center gap-1.5 text-sm text-ink-500">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
              Opens PayPal&apos;s approval page
            </span>
          </div>
        </div>
      ) : null}
      {state.kind === 'waiting' ? (
        <div role="status" className="flex flex-wrap items-center gap-3.5 rounded-[14px] bg-violet-100 p-[18px] text-violet-800">
          <Spinner />
          <div className="flex-[1_1_240px]">
            <strong>Waiting for approval</strong>
            <div className="text-sm">Finish on PayPal&apos;s page. This page updates by itself.</div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="ml-auto rounded-[10px] border border-[#A99BEB] bg-transparent px-3.5 py-[9px] text-violet-800"
          >
            Restart linking
          </button>
        </div>
      ) : null}
      {state.kind === 'linked' ? (
        <div role="status" className="flex flex-wrap items-center gap-3.5 rounded-[14px] bg-meter-100 p-[18px] text-meter-800">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12 3 3 5-6" />
          </svg>
          <div>
            <strong>Linked</strong>
            <div className="font-mono text-sm">{state.email ?? ''}</div>
          </div>
          <Link href="/app/onboarding/limits" className="ml-auto rounded-[10px] bg-ink-950 px-[18px] py-[11px] font-semibold text-white hover:text-white">
            Continue →
          </Link>
        </div>
      ) : null}
      {state.kind === 'unlinking' ? (
        <div role="status" className="flex items-center gap-3.5 rounded-[14px] bg-ground-100 p-[18px] text-ink-900">
          <Spinner />
          <div>
            <strong>Unlinking…</strong>
            <div className="text-sm">Your account unlinks when the final charge completes.</div>
          </div>
        </div>
      ) : null}
      {state.kind === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-3.5 rounded-[14px] bg-red-100 p-[18px] text-red-800">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6M12 17h.01" />
          </svg>
          <div className="flex-[1_1_260px]">
            <strong>Link not completed</strong>
            <div className="text-sm">{failText(state.reason, state.notCollected)}</div>
          </div>
          <button type="button" disabled={busy} onClick={() => void start()} className="ml-auto rounded-[10px] border-0 bg-ink-950 px-[18px] py-[11px] font-semibold text-white">
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === 'collecting' ? (
        <div role="status" className="flex flex-wrap items-center gap-3.5 rounded-[14px] bg-meter-100 p-[18px] text-meter-800">
          <Spinner />
          <div className="flex-[1_1_300px]">
            <strong>
              Linked. Collecting <span className="font-mono">{formatUsd(state.amount)}</span> of usage from before you stopped…
            </strong>
            <div className="text-sm">Agents can pay again once this charge completes.</div>
          </div>
          <span className="font-mono text-[22px] font-bold text-ink-950">{formatUsd(state.amount)}</span>
        </div>
      ) : null}
      {state.kind === 'collecting_review' ? (
        <div role="status" className="flex flex-wrap items-center gap-3.5 rounded-[14px] bg-amber-100 p-[18px] text-amber-800">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4M11 8v3M11 14h.01" />
          </svg>
          <div className="flex-[1_1_300px] text-sm">{COLLECTING_REVIEW_TEXT}</div>
          <span className="font-mono text-[22px] font-bold text-ink-950">{formatUsd(state.amount)}</span>
        </div>
      ) : null}
    </>
  );
}
