'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { PaidCallRow } from '@/lib/studio-config';
import { CALL_STATE } from '@/lib/status';
import { PaidCallsStudio } from '../studio/paid-calls-studio';
import { usePauseToggle } from './agents-list';

/** The header actions of the agent detail (design spec §10.8). */
export function AgentActions({ id, status, hasKey }: { id: string; status: string; hasKey: boolean }) {
  const toggle = usePauseToggle();
  const run = (
    <>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 4v16l13-8z" />
      </svg>
      Run this agent
    </>
  );
  const runClass = 'inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-sm font-semibold';
  return (
    <div className="ml-auto flex flex-wrap gap-2">
      <button type="button" className="inline-flex h-10 items-center rounded-lg border border-line-300 bg-white px-3 text-[13px] text-ink-950" onClick={() => void toggle(id, status === 'paused' ? 'active' : 'paused')}>
        {status === 'paused' ? 'Resume' : 'Pause'}
      </button>
      {hasKey ? (
        <Link href={`/app/live-run?agent=${encodeURIComponent(id)}`} className={`${runClass} bg-meter-400 text-ink-950 hover:text-ink-950`}>
          {run}
        </Link>
      ) : (
        <span title="This browser doesn't hold this agent's key." className="inline-flex">
          <button type="button" disabled aria-disabled="true" className={`${runClass} cursor-not-allowed border-0 bg-ground-100 text-ink-400`}>
            {run}
          </button>
        </span>
      )}
    </div>
  );
}

/** The agent's recent paid calls in AG Studio, with the status select filtering the rows. */
export function AgentCalls({
  rows,
  chargeLinks,
  licenseKey,
  capped,
}: {
  rows: PaidCallRow[];
  chargeLinks: Record<string, string>;
  licenseKey: string | undefined;
  capped: boolean;
}) {
  const [status, setStatus] = useState('');
  const visible = useMemo(() => (status === '' ? rows : rows.filter((r) => r.status === status)), [rows, status]);
  return (
    <section className="min-w-0 rounded-[14px] border border-line-200 bg-white">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-ground-100 px-4 py-3.5">
        <strong className="text-sm">Recent paid calls</strong>
        <span className="rounded-md border border-line-200 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">AG STUDIO</span>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="ml-auto h-[34px] rounded-lg border border-line-300 bg-white px-2 text-[13px]">
          <option value="">All statuses</option>
          {Object.values(CALL_STATE).map((s) => (
            <option key={s.label} value={s.label}>
              {s.label}
            </option>
          ))}
        </select>
      </header>
      <div className="p-2">
        {rows.length === 0 ? (
          <p className="m-0 p-6 text-center text-sm text-ink-500">This agent has no paid calls in the last 30 days.</p>
        ) : (
          <PaidCallsStudio kind="agent" scope="operator" rows={visible} licenseKey={licenseKey} height={480} chargeLinks={chargeLinks} />
        )}
      </div>
      {capped ? <p className="m-0 px-4 pb-3 text-[13px] text-ink-500">Showing the latest 5,000 paid calls.</p> : null}
    </section>
  );
}
