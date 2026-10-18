'use client';

import { centsToDollars } from '@/lib/money';
import { isoTime } from '@/lib/time';
import type { SettledRow } from './settled-table';

/** Settled revenue as CSV, built in the browser from the rows on the page. */
export function settledCsv(rows: SettledRow[]): string {
  const lines = ['date_utc,calls,amount_usd,paypal_fee_usd,net_usd,status'];
  for (const r of rows) {
    const money = (cents: number | null) => (cents === null ? '' : `${cents < 0 ? '-' : ''}${centsToDollars(Math.abs(cents))}`);
    lines.push([isoTime(r.createdAt), r.sellerCalls, money(r.sellerAmount), money(r.feeShare), money(r.netShare), r.status].join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function ExportCsv({ rows }: { rows: SettledRow[] }) {
  return (
    <button
      type="button"
      disabled={rows.length === 0}
      onClick={() => {
        const url = URL.createObjectURL(new Blob([settledCsv(rows)], { type: 'text/csv' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'settled-revenue.csv';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
      className="h-10 rounded-[10px] border border-line-300 bg-white px-3.5 text-sm font-semibold disabled:text-ink-400"
    >
      Export CSV
    </button>
  );
}
