import Link from 'next/link';
import { LiveRefresh } from '@/components/live/live-refresh';
import { ChargeNowButton } from '@/components/overview/charge-now';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { chargeNow } from '@/lib/charge';
import { formatUsd } from '@/lib/money';
import { load, operatorPage } from '@/lib/page';
import { SETTLEMENT_TRIGGERS, TRIGGER, statusEntry, triggerLabel } from '@/lib/status';
import { formatDateTime } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'PayPal charges · PayPer402' };

const PAGE = 50;

export default async function ChargesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { api } = await operatorPage();
  const params = await searchParams;
  const pages = Math.min(10, Math.max(1, Number(typeof params['pages'] === 'string' ? params['pages'] : '1') || 1));
  const [view, { settlements }] = await load(() => Promise.all([api.get(), api.settlements({ limit: PAGE * pages })]));
  const charge = chargeNow(view);
  const pending = view.lastSettlement?.status === 'pending';
  const { usage, caps } = view;
  const pct = caps.unsettled > 0 ? Math.min(100, (usage.notYetCharged / caps.unsettled) * 100) : 0;
  const more = settlements.length === PAGE * pages && pages < 10;

  return (
    <>
      <LiveRefresh scope="operator" />
      <TopBar title="PayPal charges" console="operator" operatorName={view.operator.name} />
      <ConsoleContent gap={18}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3.5 rounded-[14px] bg-ink-950 px-5 py-[18px] text-dark-text">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2BE38A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span className="flex-[1_1_280px] text-base">Every charge equals the exact sum of the calls it covers.</span>
          <div className="flex flex-[0_1_300px] flex-col gap-1.5">
            <div className="flex justify-between text-[13px]">
              <span>Not yet charged</span>
              <span className="tnum font-mono">
                <strong className="text-meter-400">{formatUsd(usage.notYetCharged)}</strong> / {formatUsd(caps.unsettled)}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label="Not yet charged against auto-charge amount"
              aria-valuenow={usage.notYetCharged}
              aria-valuemin={0}
              aria-valuemax={caps.unsettled}
              className="h-1.5 overflow-hidden rounded-full bg-side-line"
            >
              <div className="h-full bg-meter-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono text-xs text-dark-muted">auto-charge near {formatUsd(caps.unsettled)}</span>
          </div>
          <div className="flex flex-col items-start gap-1">
            <ChargeNowButton enabled={charge.enabled} amount={charge.amount} title={charge.title} body={charge.body} size="dark" />
            {pending ? <span className="text-xs text-dark-muted">A charge is already running</span> : null}
          </div>
        </div>

        {settlements.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border-[1.5px] border-dashed border-line-300 bg-white px-6 py-9 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-violet-100">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3A2799" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
                <path d="M9 8h6M9 12h6" />
              </svg>
            </span>
            <strong className="text-lg">No charges yet</strong>
            <p className="m-0 text-sm text-ink-700">
              Your first PayPal charge appears when usage reaches <span className="font-mono">{formatUsd(caps.unsettled)}</span> or at the end of the day.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[14px] border border-line-200 bg-white">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Trigger</th>
                  <th className="!text-right">Amount</th>
                  <th className="!text-right">Calls</th>
                  <th>Status</th>
                  <th>PayPal order</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((s) => (
                  <tr key={s.id}>
                    <td className="tnum font-mono">{formatDateTime(s.createdAt)}</td>
                    <td className="text-[13px]">{triggerLabel(s.trigger)}</td>
                    <td className="tnum text-right font-mono font-semibold">{formatUsd(s.amount)}</td>
                    <td className="tnum text-right font-mono">{s.callsCount}</td>
                    <td>
                      <StatusBadge entry={statusEntry('settlement', s.status)} />
                    </td>
                    <td className="font-mono text-xs text-ink-500">{s.paypalOrderId ?? (s.status === 'pending' ? 'pending' : '—')}</td>
                    <td className="text-right">
                      <Link href={`/app/charges/${encodeURIComponent(s.id)}`} className="text-sm font-semibold">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? (
          <Link href={`/app/charges?pages=${pages + 1}`} scroll={false} className="self-center rounded-[10px] border border-line-300 bg-white px-4 py-2.5 text-sm font-semibold text-ink-950 hover:text-ink-950">
            Load more
          </Link>
        ) : null}
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink-500">
          {SETTLEMENT_TRIGGERS.map((t) => (
            <span key={t}>
              <strong className="text-ink-950">{TRIGGER[t].label}</strong> · {t === 'threshold' ? `unpaid usage neared Auto-charge at (${formatUsd(caps.unsettled)})` : TRIGGER[t].legend}
            </span>
          ))}
        </div>
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
