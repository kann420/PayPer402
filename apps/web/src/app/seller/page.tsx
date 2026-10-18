import Link from 'next/link';
import { LiveRefresh } from '@/components/live/live-refresh';
import { SettledTable } from '@/components/seller/settled-table';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { PaidCallsStudio } from '@/components/studio/paid-calls-studio';
import { loadSellerCalls } from '@/lib/loaders';
import { formatUsd } from '@/lib/money';
import { load, sellerPage, sessionOperatorName } from '@/lib/page';
import { sellerRows } from '@/lib/rows';
import { sellerKpis } from '@/lib/seller-kpis';
import { formatDate, nowSeconds } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Seller overview · PayPer402' };

export default async function SellerOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { api, deps } = await sellerPage();
  const [view, calls, { settlements }, catalog] = await load(() => Promise.all([api.get(), loadSellerCalls(api), api.settlements({ limit: 5 }), deps.catalog.get()]));
  const params = await searchParams;
  const now = nowSeconds();
  const kpis = sellerKpis(calls.calls, view.usage.revenueToday, now);
  const rows = sellerRows(calls.calls, catalog);
  const kpi = 'flex flex-col gap-1.5 rounded-[14px] border border-line-200 bg-white p-4';
  const value = 'tnum font-mono text-[26px] font-semibold';
  const change = kpis.changeVsYesterday;
  return (
    <>
      <LiveRefresh scope="seller" />
      <TopBar title="Overview" subtitle={`${view.seller.name} · ${formatDate(now)}`} console="seller" operatorName={await sessionOperatorName()} askAi="panel" />
      <ConsoleContent gap={18}>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Revenue today</span>
            <span className={value}>{formatUsd(view.usage.revenueToday)}</span>
            <span className={`text-xs ${change === undefined ? 'text-ink-500' : change >= 0 ? 'text-meter-800' : 'text-red-800'}`}>
              {change === undefined ? 'today' : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}% vs yesterday`}
            </span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Revenue this week</span>
            <span className={value}>{formatUsd(kpis.revenueWeek)}</span>
            <span className="text-xs text-ink-500">7 days</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Paid calls today</span>
            <span className={value}>{view.usage.callsToday}</span>
            <span className="text-xs text-ink-500">{catalog === undefined ? 'endpoints' : `${catalog.services.length} endpoints`}</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Unique agents</span>
            <span className={value}>{view.usage.uniqueAgentsToday}</span>
            <span className="text-xs text-ink-500">today</span>
          </div>
          <div className={`${kpi} border-violet-300 bg-[#F7F5FF]`}>
            <span className="text-[13px] text-violet-800">Not yet charged</span>
            <span className={value}>{formatUsd(view.usage.pending)}</span>
            <span className="text-xs text-violet-800">
              ◷ {view.usage.pendingCalls} paid call{view.usage.pendingCalls === 1 ? '' : 's'} · to be included in upcoming PayPal charges
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <h2 className="m-0 text-[17px]">Revenue</h2>
          <span className="rounded-md border border-line-200 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">AG STUDIO</span>
        </div>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border-[1.5px] border-dashed border-line-300 bg-white px-6 py-9 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-amber-100">
              <span className="font-mono font-bold text-amber-800">402</span>
            </span>
            <strong className="text-lg">No paid calls yet</strong>
            <p className="m-0 text-sm text-ink-700">When an agent pays for an API call, it shows up here within a second.</p>
          </div>
        ) : (
          <PaidCallsStudio kind="seller" scope="seller" rows={rows} ai aiOpen={params['ai'] === '1'} licenseKey={deps.config.agStudioLicenseKey} height={600} rangeLabel="Last 30 days" />
        )}
        {calls.capped ? <p className="m-0 text-[13px] text-ink-500">Showing the latest 5,000 paid calls.</p> : null}

        <section className="flex flex-col gap-3">
          <div className="flex items-center">
            <strong className="text-sm">Settled revenue</strong>
            <Link href="/seller/revenue" className="ml-auto text-[13px]">
              View all
            </Link>
          </div>
          <SettledTable rows={settlements} />
        </section>
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
