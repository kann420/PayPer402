'use client';

import { useState } from 'react';
import { errorCopy } from '@/lib/copy';
import type { Verification } from '@/lib/facilitator';
import { formatUsd } from '@/lib/money';
import { formatTime } from '@/lib/time';
import { callApi, handleEnded } from '../shell/session-client';
import { btn } from '../ui/button';

const CHECK_LABELS: Record<string, string> = {
  capture_found: 'Capture exists',
  completed: 'Status',
  amount: 'Amount',
  currency: 'Currency',
  invoice: 'Invoice id',
  order: 'Order id',
};

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; result: Verification } | { kind: 'error'; message: string };

/** `2026-11-10T15:26:28Z` → `Nov 10, 15:26:28 UTC`. */
function paypalTime(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${d.getUTCDate()}, ${formatTime(Math.floor(ms / 1000))} UTC`;
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-label="matches" className="text-meter-700">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-label="does not match" className="text-red-700">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * "Verify with PayPal": reads this charge's capture straight from the PayPal API (through the
 * facilitator, which holds the credentials) and compares it with the ledger, field by field.
 */
export function VerifyWithPayPal({ settlementId, captureId }: { settlementId: string; captureId: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const verify = async () => {
    setState({ kind: 'busy' });
    const res = await callApi<{ verification: Verification }>(`/api/operator/settlements/${encodeURIComponent(settlementId)}/verify`);
    if (res.ok) {
      setState({ kind: 'done', result: res.verification });
      return;
    }
    if (handleEnded(res)) return;
    setState({ kind: 'error', message: errorCopy(res.error, res.message) });
  };

  const result = state.kind === 'done' ? state.result : undefined;
  const captured = paypalTime(result?.paypal?.createTime ?? null);

  return (
    <section aria-label="Verify with PayPal" className="flex flex-col gap-3.5 rounded-[14px] border border-line-200 bg-white p-[18px]">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-[min(100%,320px)] flex-1 flex-col gap-1">
          <strong className="text-sm">Proof from PayPal</strong>
          <p className="m-0 text-sm text-ink-700">
            Read capture <span className="font-mono text-[13px] text-ink-950">{captureId}</span> straight from the PayPal API and compare it with this
            charge. The same transaction id and invoice id appear in the payer&apos;s PayPal account.
          </p>
        </div>
        <button type="button" onClick={verify} disabled={state.kind === 'busy'} className={btn.primary}>
          {state.kind === 'busy' ? (
            <svg className="pg-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
              <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
            </svg>
          )}
          {state.kind === 'busy' ? 'Asking PayPal…' : result ? 'Verify again' : 'Verify with PayPal'}
        </button>
      </div>

      {state.kind === 'error' ? (
        <div role="alert" className="rounded-[10px] border border-red-300 bg-red-100 px-3.5 py-3 text-sm text-red-800">
          {state.message}
        </div>
      ) : null}

      {result ? (
        <div role="status" className="flex flex-col gap-3">
          <div
            className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border px-3.5 py-3 text-sm ${
              result.verified ? 'border-meter-400/60 bg-meter-100 text-meter-800' : 'border-red-300 bg-red-100 text-red-800'
            }`}
          >
            <strong>{result.verified ? 'Verified with PayPal' : result.paypal ? 'PayPal disagrees with this charge' : 'PayPal has no such capture'}</strong>
            <span>
              {result.paypal
                ? `PayPal reports ${result.paypal.status} for ${formatUsd(result.paypal.amount)} ${result.paypal.currency}${captured ? `, captured ${captured}` : ''}.`
                : 'The capture id on this charge was not found at PayPal.'}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="text-ink-500">
                  <th className="border-b border-line-200 py-2 pr-3 font-normal">Check</th>
                  <th className="border-b border-line-200 py-2 pr-3 font-normal">PayPer402 ledger</th>
                  <th className="border-b border-line-200 py-2 pr-3 font-normal">PayPal API</th>
                  <th className="w-8 border-b border-line-200 py-2 font-normal">
                    <span className="sr-only">Result</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.checks.map((c) => (
                  <tr key={c.name}>
                    <td className="border-b border-ground-100 py-2 pr-3">{CHECK_LABELS[c.name] ?? c.name}</td>
                    <td className="tnum border-b border-ground-100 py-2 pr-3 font-mono break-all">{c.expected}</td>
                    <td className="tnum border-b border-ground-100 py-2 pr-3 font-mono break-all">{c.actual ?? '—'}</td>
                    <td className="border-b border-ground-100 py-2">
                      <Mark ok={c.ok} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="m-0 font-mono text-xs text-ink-500">
            GET /v2/payments/captures/{result.paypal?.captureId ?? captureId} · PayPal sandbox · checked {formatTime(result.checkedAt)} UTC
          </p>
        </div>
      ) : null}
    </section>
  );
}
