import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChargeCalls } from '@/components/charges/charge-calls';
import { VerifyWithPayPal } from '@/components/charges/verify-paypal';
import { LiveRefresh } from '@/components/live/live-refresh';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { StatusBadge } from '@/components/ui/status-badge';
import { chargeNote } from '@/lib/charge';
import { isFacilitatorError } from '@/lib/facilitator';
import { formatUsd } from '@/lib/money';
import { load, operatorPage } from '@/lib/page';
import { groupByService, operatorRows, shortCharge } from '@/lib/rows';
import { statusEntry, triggerLabel } from '@/lib/status';
import { formatDate, formatDateTime, formatTime } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'PayPal charge · PayPer402' };

const NOTE_STYLE = {
  charging: 'border-amber-300 bg-[#FFF8EA] text-amber-800',
  declined: 'border-red-300 bg-red-100 text-red-800',
  review: 'border-amber-300 bg-amber-100 text-amber-800',
} as const;

export default async function ChargeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { api, deps } = await operatorPage();
  let settlement;
  try {
    settlement = (await load(() => api.settlement(id))).settlement;
  } catch (error) {
    if (isFacilitatorError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const [view, catalog] = await load(() => Promise.all([api.get(), deps.catalog.get()]));
  const note = chargeNote(settlement);
  const groups = groupByService(settlement.commitments, catalog);
  const sum = settlement.commitments.reduce((n, c) => n + c.amount, 0);
  const trigger = settlement.trigger === 'threshold' ? `Threshold (near ${formatUsd(view.caps.unsettled)})` : triggerLabel(settlement.trigger);
  const capture = settlement.paypalCaptureId ?? (settlement.status === 'pending' ? 'pending' : '—');
  const ref = 'flex justify-between gap-3';

  return (
    <>
      <LiveRefresh scope="operator" />
      <div className="flex flex-col gap-2.5 border-b border-line-200 bg-white px-7 py-5">
        <nav aria-label="Breadcrumb" className="text-[13px] text-ink-500">
          <Link href="/app/charges">PayPal charges</Link> / <span className="font-mono">{shortCharge(settlement.id)}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h1 className="tnum m-0 font-mono text-[34px] tracking-[-0.02em]">{formatUsd(settlement.amount)}</h1>
          <StatusBadge entry={statusEntry('settlement', settlement.status)} />
          <span className="text-sm text-ink-700">
            PayPal charge · {triggerLabel(settlement.trigger)} · {formatDate(settlement.createdAt)} {formatTime(settlement.createdAt).slice(0, 5)} · {settlement.callsCount} paid
            call{settlement.callsCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <ConsoleContent gap={18}>
        {note === undefined ? null : (
          <div role={note.role} className={`flex items-start gap-3 rounded-[14px] border px-[18px] py-4 ${NOTE_STYLE[note.kind]}`}>
            {note.kind === 'charging' ? (
              <svg className="pg-spin flex-none" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M12 3a9 9 0 1 0 9 9" />
              </svg>
            ) : (
              <svg className="flex-none" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6M12 17h.01" />
              </svg>
            )}
            <div>
              <strong>{note.title}</strong>
              <div className="text-sm">{note.text}</div>
            </div>
          </div>
        )}

        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <section className="flex flex-col gap-3 rounded-[14px] border border-line-200 bg-white p-[18px]">
            <strong className="text-sm">Summary</strong>
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-[13px] text-ink-500">Amount</dt>
                <dd className="tnum m-0 font-mono">{formatUsd(settlement.amount)}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-ink-500">Trigger</dt>
                <dd className="m-0">{trigger}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-ink-500">Created</dt>
                <dd className="tnum m-0 font-mono">
                  {formatDateTime(settlement.createdAt)}
                  {formatTime(settlement.createdAt).slice(5)}
                </dd>
              </div>
              <div>
                <dt className="text-[13px] text-ink-500">Paid calls</dt>
                <dd className="tnum m-0 font-mono">{settlement.callsCount}</dd>
              </div>
            </dl>
          </section>
          <section className="flex flex-col gap-3 rounded-[14px] border border-line-200 bg-white p-[18px]">
            <strong className="text-sm">References</strong>
            <dl className="m-0 flex flex-col gap-2.5 font-mono text-[13px]">
              <div className={ref}>
                <dt className="text-ink-500">Charge id</dt>
                <dd className="m-0 break-all">{settlement.id}</dd>
              </div>
              <div className={ref}>
                <dt className="text-ink-500">PayPal order id</dt>
                <dd className="m-0">{settlement.paypalOrderId ?? '—'}</dd>
              </div>
              <div className={ref}>
                <dt className="text-ink-500">PayPal capture id</dt>
                <dd className="m-0">{capture}</dd>
              </div>
              <div className={ref}>
                <dt className="text-ink-500">Payer</dt>
                <dd className="m-0">{view.wallet.payerEmailMasked ?? '—'}</dd>
              </div>
            </dl>
          </section>
        </div>

        {settlement.paypalCaptureId === null ? null : <VerifyWithPayPal settlementId={settlement.id} captureId={settlement.paypalCaptureId} />}

        <section className="flex flex-col gap-3 rounded-[14px] border border-line-200 bg-white p-[18px]">
          <strong className="text-sm">By service</strong>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
            {groups.map((g) => {
              const eq = g.text.lastIndexOf(' = ');
              return (
                <div key={g.service} className="flex flex-col gap-0.5 rounded-[10px] border border-ground-100 p-3">
                  <span className="text-[13px]">{g.service}</span>
                  <span className="tnum font-mono text-sm text-ink-800">
                    {g.text.slice(0, eq + 3)}
                    <strong className="text-ink-950">{g.text.slice(eq + 3)}</strong>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <ChargeCalls rows={operatorRows(settlement.commitments, catalog)} licenseKey={deps.config.agStudioLicenseKey} sum={sum} amount={settlement.amount} count={settlement.commitments.length} />
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
