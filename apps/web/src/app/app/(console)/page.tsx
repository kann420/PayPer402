import Link from 'next/link';
import { ChargeNowButton } from '@/components/overview/charge-now';
import { OverviewBanner } from '@/components/overview/overview-banner';
import { SpendSection } from '@/components/overview/spend-section';
import { LiveRefresh } from '@/components/live/live-refresh';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { KpiCard, Meter } from '@/components/ui/kpi';
import { StatusBadge } from '@/components/ui/status-badge';
import { pickBanner } from '@/lib/banners';
import { chargeNow } from '@/lib/charge';
import { loadOperatorCalls } from '@/lib/loaders';
import { formatUsd } from '@/lib/money';
import { load, operatorPage } from '@/lib/page';
import { operatorRows } from '@/lib/rows';
import { BLOCK_REASON_TEXT, isBlockReason, statusEntry } from '@/lib/status';
import { formatDate, formatDateTime, nowSeconds } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview · PayPer402' };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { api, deps } = await operatorPage();
  const [view, { agents }, calls, catalog] = await load(() => Promise.all([api.get(), api.agents(), loadOperatorCalls(api), deps.catalog.get()]));
  const params = await searchParams;
  const rows = operatorRows(calls.calls, catalog);
  const banner = pickBanner(view);
  const charge = chargeNow(view);
  const { caps, usage, wallet } = view;
  const spentPct = caps.daily > 0 ? usage.spentToday / caps.daily : 0;
  const last = view.lastSettlement;
  const paused = agents.filter((a) => a.status === 'paused').length;
  const blockText = isBlockReason(view.blockReason) ? BLOCK_REASON_TEXT[view.blockReason] : undefined;
  const blocked = blockText !== undefined;

  return (
    <>
      <LiveRefresh scope="operator" />
      <TopBar title="Overview" subtitle={`Today · ${formatDate(nowSeconds())}`} console="operator" operatorName={view.operator.name} askAi="panel" />
      <ConsoleContent>
        {banner === undefined ? null : <OverviewBanner banner={banner} />}
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
          <KpiCard label="Spent today" value={formatUsd(usage.spentToday)}>
            <Meter label="Spent today against daily limit" value={usage.spentToday} max={caps.daily} color={spentPct > 0.9 ? '#D97706' : '#0E9F5C'} />
            <span className="tnum font-mono text-xs text-ink-500">of {formatUsd(caps.daily)} daily limit</span>
          </KpiCard>
          <KpiCard label="Not yet charged" value={formatUsd(usage.notYetCharged)}>
            <Meter label="Not yet charged against auto-charge amount" value={usage.notYetCharged} max={caps.unsettled} color="#7C5CFF" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="tnum font-mono text-xs text-ink-500">auto-charge near {formatUsd(caps.unsettled)}</span>
              <ChargeNowButton enabled={charge.enabled} amount={charge.amount} title={charge.title} body={charge.body} />
            </div>
            {wallet.status === 'stopped_by_payer' && usage.notCollected > 0 ? (
              <span className="text-xs font-semibold text-red-800">
                Not collected <span className="font-mono">{formatUsd(usage.notCollected)}</span> · charged when you re-link
              </span>
            ) : null}
          </KpiCard>
          <KpiCard label="Last PayPal charge" value={last === null ? '—' : formatUsd(last.amount)}>
            <span className="text-[13px] text-ink-500">
              {last === null ? 'No charges yet' : `${formatDateTime(last.createdAt)} · ${statusEntry('settlement', last.status).label}`}
            </span>
          </KpiCard>
          <KpiCard label="Active agents" value={blocked ? `${view.activeAgents} · blocked` : String(view.activeAgents)}>
            <span className="text-[13px] text-ink-500">
              {blockText !== undefined ? blockText : agents.length === 0 ? 'No agents yet' : `${paused} paused`}
            </span>
          </KpiCard>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] border border-line-200 bg-white px-[18px] py-4">
          <div className="flex items-center gap-2.5">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0C0F0E" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
              <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            </svg>
            <strong>PayPal link</strong>
          </div>
          <StatusBadge entry={statusEntry('wallet', wallet.status)} />
          {wallet.payerEmailMasked === null ? null : <span className="font-mono text-sm">{wallet.payerEmailMasked}</span>}
          <span className="text-sm text-ink-500">
            {wallet.status === 'stopped_by_payer' && wallet.stoppedAt !== null
              ? `Stopped ${formatDateTime(wallet.stoppedAt)}`
              : wallet.linkedAt !== null && (wallet.status === 'active' || wallet.status === 'unlinking')
                ? `Linked since ${formatDate(wallet.linkedAt)}`
                : 'No PayPal account linked'}
          </span>
          <Link href="/app/settings" className="ml-auto text-sm font-semibold">
            Manage
          </Link>
        </div>

        <SpendSection
          rows={rows}
          agents={[...new Set(agents.map((a) => a.name))]}
          aiOpen={params['ai'] === '1'}
          licenseKey={deps.config.agStudioLicenseKey}
          capped={calls.capped}
        />
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
