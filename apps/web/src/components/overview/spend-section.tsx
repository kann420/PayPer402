'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PaidCallsStudio } from '../studio/paid-calls-studio';
import type { PaidCallRow } from '@/lib/studio-config';
import { isoDay, nowSeconds } from '@/lib/time';

const RANGES = [7, 14, 30] as const;

/** Rows within the last `days` UTC days, and of one agent when set (filtered in the browser). */
export function filterRows(rows: PaidCallRow[], days: number, agent: string, now: number): PaidCallRow[] {
  const from = isoDay(now - (days - 1) * 86_400);
  return rows.filter((r) => r.day >= from && (agent === '' || r.agent === agent));
}

/** The Overview's Spend section (design spec §10.7): range and agent filters, then AG Studio. */
export function SpendSection({
  rows,
  agents,
  aiOpen,
  licenseKey,
  capped,
}: {
  rows: PaidCallRow[];
  agents: string[];
  aiOpen: boolean;
  licenseKey: string | undefined;
  capped: boolean;
}) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const [agent, setAgent] = useState('');
  const [now] = useState(nowSeconds);
  const visible = useMemo(() => filterRows(rows, days, agent, now), [rows, days, agent, now]);
  const empty = visible.length === 0;
  return (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-[17px]">Spend</h2>
        <span className="rounded-md border border-line-200 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">AG STUDIO</span>
        <div className="ml-auto flex flex-wrap gap-1.5" role="group" aria-label="Range">
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === days}
              onClick={() => setDays(d)}
              className={`h-[34px] rounded-lg border px-3 text-[13px] ${d === days ? 'border-ink-950 bg-ink-950 text-white' : 'border-line-300 bg-white'}`}
            >
              {d}d
            </button>
          ))}
          <select aria-label="Agent filter" value={agent} onChange={(event) => setAgent(event.target.value)} className="h-[34px] rounded-lg border border-line-300 bg-white px-2 text-[13px]">
            <option value="">All agents</option>
            {agents.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {empty ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-line-300 bg-white px-6 py-12 text-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#5B635F" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
            <path d="M9 8h6M9 12h4" />
          </svg>
          <strong className="text-lg">No paid calls yet</strong>
          <p className="m-0 max-w-[420px] text-ink-700">Charts fill in as soon as an agent pays for its first call. Create an agent, or run the demo agent to see it live.</p>
          <div className="flex flex-wrap justify-center gap-2.5">
            <Link href="/app/agents?new=1" className="rounded-[10px] bg-ink-950 px-4 py-[11px] font-semibold text-white hover:text-white">
              Create an agent
            </Link>
            <Link href="/app/live-run" className="rounded-[10px] border-[1.5px] border-ink-950 px-4 py-2.5 font-semibold text-ink-950 hover:text-ink-950">
              Run the demo agent
            </Link>
          </div>
        </div>
      ) : (
        <PaidCallsStudio kind="overview" scope="operator" rows={visible} ai aiOpen={aiOpen} licenseKey={licenseKey} height={560} rangeLabel={`Last ${days} days`} />
      )}
      {capped ? <p className="m-0 text-[13px] text-ink-500">Showing the latest 5,000 paid calls.</p> : null}
    </>
  );
}
