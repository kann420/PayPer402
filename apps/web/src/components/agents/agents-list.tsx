'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { errorCopy } from '@/lib/copy';
import { formatUsd } from '@/lib/money';
import { agentBadge, BLOCK_REASON_TEXT, isBlockReason } from '@/lib/status';
import { lastCall, nowSeconds } from '@/lib/time';
import { callApi, handleEnded } from '../shell/session-client';
import { btn } from '../ui/button';
import { Drawer } from '../ui/drawer';
import { StatusBadge } from '../ui/status-badge';
import { useToast } from '../ui/toast';
import { AgentNameForm, KeyPanel, type CreatedKey } from './agent-creator';
import { ClaimPanel, type ClaimInfo } from './claim-panel';

export interface AgentListItem {
  id: string;
  name: string;
  keyFingerprint: string;
  status: string;
  spentToday: number;
  spentTotal: number;
  callsToday: number;
  lastCallAt: number | null;
  blockReason: string | null;
}

/** Pause or resume, with the toasts of design spec §10.8. */
export function usePauseToggle(): (id: string, next: 'active' | 'paused') => Promise<void> {
  const router = useRouter();
  const toast = useToast();
  const patch = async (id: string, next: 'active' | 'paused', undo: boolean): Promise<void> => {
    const res = await callApi<{ agent: { status: string } }>(`/api/operator/agents/${encodeURIComponent(id)}`, { status: next }, 'PATCH');
    if (!res.ok) {
      if (!handleEnded(res)) toast({ text: errorCopy(res.error, res.message), icon: 'error' });
      return;
    }
    router.refresh();
    if (undo) return;
    if (next === 'paused') toast({ text: 'Agent paused', icon: 'pause', action: { label: 'Undo', onClick: () => void patch(id, 'active', true) } });
    else toast({ text: 'Agent resumed' });
  };
  return (id, next) => patch(id, next, false);
}

/** The New agent drawer: the name, then the key shown once (design spec §10.8). */
export function NewAgentDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [claim, setClaim] = useState<ClaimInfo | null>(null);
  const close = () => {
    setCreated(null);
    setClaim(null);
    onClose();
    router.refresh();
  };
  return (
    <Drawer open={open} title="New agent" onClose={close}>
      {claim !== null ? (
        <>
          <ClaimPanel info={claim} />
          <button type="button" className={`${btn.primary} self-start`} onClick={close}>
            Done
          </button>
        </>
      ) : created === null ? (
        <AgentNameForm onCreated={setCreated} onClaim={setClaim} />
      ) : (
        <>
          <KeyPanel created={created} />
          <button type="button" className={`${btn.primary} self-start`} onClick={close}>
            I saved the key
          </button>
        </>
      )}
    </Drawer>
  );
}

/** The agents table (board `Agents`): search and status filters in the browser. */
export function AgentsList({ agents, blockReason, openNew }: { agents: AgentListItem[]; blockReason: string | null; openNew: boolean }) {
  const toggle = usePauseToggle();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [drawer, setDrawer] = useState(openNew);
  const [now] = useState(nowSeconds);
  useEffect(() => {
    const open = () => setDrawer(true);
    window.addEventListener('pp402:new-agent', open);
    return () => window.removeEventListener('pp402:new-agent', open);
  }, []);
  const visible = useMemo(
    () => agents.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || a.status === filter)),
    [agents, query, filter],
  );

  return (
    <>
      {isBlockReason(blockReason) ? (
        <div role="alert" className="flex items-center gap-2.5 rounded-[14px] border border-red-300 bg-red-100 px-4 py-3.5 text-sm text-red-800">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M5.6 5.6l12.8 12.8" />
          </svg>
          <span>
            <strong>All agents are blocked.</strong> {BLOCK_REASON_TEXT[blockReason]}.
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex h-10 flex-[0_1_280px] items-center gap-2 rounded-[10px] border border-line-300 bg-white px-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B635F" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
          <input aria-label="Search agents" placeholder="Search agents" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full border-0 text-sm outline-none" />
        </div>
        <div role="group" aria-label="Status filter" className="flex gap-1.5">
          {(['all', 'active', 'paused'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={filter === f ? btn.ghostSmOn : btn.ghostSm}
            >
              {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Paused'}
            </button>
          ))}
        </div>
      </div>
      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-[1.5px] border-dashed border-line-300 bg-white px-6 py-9 text-center">
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-meter-100">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#087A3D" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="8" width="14" height="11" rx="3" />
              <path d="M12 4v4M9 13h.01M15 13h.01" />
            </svg>
          </span>
          <strong className="text-lg">No agents yet</strong>
          <p className="m-0 text-sm text-ink-700">Create an agent to get a key. It can start paying per call right away.</p>
          <button type="button" className={btn.primary} onClick={() => setDrawer(true)}>
            Create an agent
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-line-200 bg-white">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th className="!text-right">Spent today</th>
                <th className="!text-right">Spent total</th>
                <th className="!text-right">Calls today</th>
                <th>Last call</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => {
                const badge = agentBadge(a.status, a.blockReason);
                return (
                  <tr key={a.id} className="pg-row">
                    <td>
                      <Link href={`/app/agents/${encodeURIComponent(a.id)}`} className="font-mono font-semibold text-ink-950 hover:text-ink-950">
                        {a.name}
                      </Link>
                      <div className="font-mono text-xs text-ink-500">{a.keyFingerprint}</div>
                    </td>
                    <td>
                      <StatusBadge entry={badge} tooltip={badge.tooltip} />
                    </td>
                    <td className="tnum text-right font-mono">{formatUsd(a.spentToday)}</td>
                    <td className="tnum text-right font-mono">{formatUsd(a.spentTotal)}</td>
                    <td className="tnum text-right font-mono">{a.callsToday}</td>
                    <td className="tnum font-mono text-ink-800">{lastCall(a.lastCallAt, now)}</td>
                    <td className="text-right">
                      <div className="inline-flex gap-1.5">
                        <button type="button" className={btn.ghostSm} onClick={() => void toggle(a.id, a.status === 'paused' ? 'active' : 'paused')}>
                          {a.status === 'paused' ? 'Resume' : 'Pause'}
                        </button>
                        <Link href={`/app/agents/${encodeURIComponent(a.id)}`} className={btn.ghostSm}>
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-sm text-ink-500">
                    No agents match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 text-[13px] text-ink-500">When the PayPal link is not active or a limit is reached, every agent on the account shows Blocked. Hover the badge to see why.</p>
      <NewAgentDrawer open={drawer} onClose={() => setDrawer(false)} />
    </>
  );
}
