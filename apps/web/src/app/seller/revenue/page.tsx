import { LiveRefresh } from '@/components/live/live-refresh';
import { ExportCsv } from '@/components/seller/export-csv';
import { SettledTable } from '@/components/seller/settled-table';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { formatUsd } from '@/lib/money';
import { load, sellerPage, sessionOperatorName } from '@/lib/page';
import { weeklySettled } from '@/lib/seller-kpis';
import { nowSeconds } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settled revenue · PayPer402' };

export default async function SellerRevenuePage() {
  const { api } = await sellerPage();
  const [view, { settlements }] = await load(() => Promise.all([api.get(), api.settlements({ limit: 200 })]));
  const week = weeklySettled(settlements, nowSeconds());
  const kpi = 'flex flex-col gap-1 rounded-[14px] border border-line-200 bg-white p-4';
  return (
    <>
      <LiveRefresh scope="seller" />
      <TopBar title="Settled revenue" console="seller" operatorName={await sessionOperatorName()}>
        <div className="order-last">
          <ExportCsv rows={settlements} />
        </div>
      </TopBar>
      <ConsoleContent gap={18}>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Gross this week</span>
            <span className="tnum font-mono text-2xl font-semibold">{formatUsd(week.gross)}</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">PayPal fees</span>
            <span className="tnum font-mono text-2xl font-semibold">{formatUsd(-week.fees)}</span>
          </div>
          <div className={kpi}>
            <span className="text-[13px] text-ink-500">Net this week</span>
            <span className={`tnum font-mono text-2xl font-semibold ${week.net < 0 ? 'text-red-800' : 'text-meter-800'}`}>{formatUsd(week.net)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-violet-300 bg-[#F7F5FF] px-[18px] py-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-100 px-2.5 py-[3px] text-xs font-semibold text-violet-800">
            <span aria-hidden="true">◷</span>Not yet charged
          </span>
          <span className="tnum font-mono text-[22px] font-semibold">{formatUsd(view.usage.pending)}</span>
          <span className="text-sm text-ink-800">
            <span className="tnum font-mono">{view.usage.pendingCalls}</span> paid call{view.usage.pendingCalls === 1 ? '' : 's'}, included in upcoming charges
          </span>
        </div>
        <SettledTable rows={settlements} />
        <p className="m-0 text-[13px] text-ink-500">Amounts are your share of each PayPal charge, after PayPal&apos;s fee. Batching paid calls keeps the fee small.</p>
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
