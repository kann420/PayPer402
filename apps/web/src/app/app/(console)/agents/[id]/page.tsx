import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentActions, AgentCalls } from '@/components/agents/agent-detail';
import { LiveRefresh } from '@/components/live/live-refresh';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { StatusBadge } from '@/components/ui/status-badge';
import { isFacilitatorError } from '@/lib/facilitator';
import { loadOperatorCalls } from '@/lib/loaders';
import { formatUsd } from '@/lib/money';
import { load, operatorPage } from '@/lib/page';
import { chargeLinks, operatorRows } from '@/lib/rows';
import { agentBadge } from '@/lib/status';
import { lastCall, nowSeconds } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agent · PayPer402' };

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { api, deps, session } = await operatorPage();
  let agent;
  try {
    agent = (await load(() => api.agent(id))).agent;
  } catch (error) {
    if (isFacilitatorError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const [calls, catalog] = await load(() => Promise.all([loadOperatorCalls(api, id), deps.catalog.get()]));
  const badge = agentBadge(agent.status, agent.blockReason);
  const hasKey = session.agents.some((a) => a.id === agent.id);
  const kpi = 'flex flex-col gap-1 rounded-[14px] border border-line-200 bg-white p-4';
  const value = 'tnum font-mono text-2xl font-semibold';
  return (
    <>
      <LiveRefresh scope="operator" />
      <div className="flex flex-col gap-3 border-b border-line-200 bg-white px-7 py-5">
        <nav aria-label="Breadcrumb" className="text-[13px] text-ink-500">
          <Link href="/app/agents">Agents</Link> / <span className="font-mono">{agent.name}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <span className="inline-flex size-11 items-center justify-center rounded-xl bg-meter-100">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#087A3D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="8" width="14" height="11" rx="3" />
              <path d="M12 4v4M9 13h.01M15 13h.01" />
            </svg>
          </span>
          <h1 className="m-0 font-mono text-2xl">{agent.name}</h1>
          <StatusBadge entry={badge} tooltip={badge.tooltip} />
          <span className="rounded-md bg-ground-50 px-2 py-1 font-mono text-[13px] text-ink-800">{agent.keyFingerprint}</span>
          <AgentActions id={agent.id} status={agent.status} hasKey={hasKey} />
        </div>
      </div>
      <ConsoleContent gap={18}>
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]">
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Spent today</span>
            <span className={value}>{formatUsd(agent.spentToday)}</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Spent total</span>
            <span className={value}>{formatUsd(agent.spentTotal)}</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Calls today</span>
            <span className={value}>{agent.callsToday}</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Last call</span>
            <span className={value}>{lastCall(agent.lastCallAt, nowSeconds())}</span>
          </div>
        </div>
        <AgentCalls rows={operatorRows(calls.calls, catalog)} chargeLinks={chargeLinks(calls.calls)} licenseKey={deps.config.agStudioLicenseKey} capped={calls.capped} />
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
