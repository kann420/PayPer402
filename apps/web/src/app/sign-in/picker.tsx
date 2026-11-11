'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { postSession } from '@/components/shell/session-client';

const CARD =
  'pick flex w-full flex-col gap-[18px] rounded-[20px] border-[1.5px] border-line-200 bg-white p-[30px] text-left text-ink-950 transition-[box-shadow,border-color,transform] duration-300 hover:-translate-y-1 hover:border-ink-950 hover:shadow-[0_24px_48px_-20px_rgba(12,15,14,.25)] disabled:cursor-wait';

/** The two demo cards of the SignIn board (design spec §10.2). */
export function DemoPicker({ returning }: { returning: string | undefined }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'operator' | 'seller' | 'over' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (role: 'operator' | 'seller', startOver = false) => {
    setBusy(startOver ? 'over' : role);
    setError(null);
    const result = await postSession(startOver ? { role, startOver } : { role });
    if (result.ok) {
      router.push(result.next);
      return;
    }
    setBusy(null);
    setError(result.message);
  };

  return (
    <>
      <div className="grid w-full max-w-[820px] gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
        <div className="flex flex-col gap-2">
          <button type="button" className={CARD} disabled={busy !== null} onClick={() => void go('operator')}>
            <span className="inline-flex size-[52px] items-center justify-center rounded-[14px] bg-meter-100">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#087A3D" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="5" y="8" width="14" height="11" rx="3" />
                <path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2" />
              </svg>
            </span>
            <span className="flex flex-col gap-1">
              <strong className="text-[22px]">Operator demo</strong>
              <span className="text-base text-ink-700">I run AI agents</span>
            </span>
            <span className="border-t border-line-200 pt-3.5 font-mono text-[13px] text-ink-500">
              {returning === undefined ? 'Your own demo operator · PayPal sandbox' : `Continue as ${returning}`}
            </span>
            <span className="self-start rounded-[10px] bg-ink-950 px-[18px] py-3 text-[15px] font-semibold text-white">
              {busy === 'operator' ? 'Opening…' : 'Continue as operator →'}
            </span>
          </button>
          {returning === undefined ? null : (
            <button
              type="button"
              className="self-center border-0 bg-transparent p-1 text-sm font-semibold text-meter-700"
              disabled={busy !== null}
              onClick={() => void go('operator', true)}
            >
              {busy === 'over' ? 'Starting…' : 'Start a new demo account'}
            </button>
          )}
        </div>
        <button type="button" className={`${CARD} self-start`} disabled={busy !== null} onClick={() => void go('seller')}>
          <span className="inline-flex size-[52px] items-center justify-center rounded-[14px] bg-violet-100">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B3FD9" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m8 9-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />
            </svg>
          </span>
          <span className="flex flex-col gap-1">
            <strong className="text-[22px]">Seller demo</strong>
            <span className="text-base text-ink-700">I sell an API</span>
          </span>
          <span className="border-t border-line-200 pt-3.5 font-mono text-[13px] text-ink-500">Acme Data · 5 priced endpoints</span>
          <span className="self-start rounded-[10px] border-[1.5px] border-ink-950 bg-white px-[18px] py-[11px] text-[15px] font-semibold text-ink-950">
            {busy === 'seller' ? 'Opening…' : 'Continue as seller →'}
          </span>
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="m-0 rounded-xl border border-red-300 bg-red-100 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}
    </>
  );
}
