'use client';

import { formatUsd } from '@/lib/money';
import type { PaidCallRow } from '@/lib/studio-config';
import { PaidCallsStudio } from '../studio/paid-calls-studio';

/** "Included paid calls" in AG Studio, then the sum rows (design spec §10.9). */
export function ChargeCalls({ rows, licenseKey, sum, amount, count }: { rows: PaidCallRow[]; licenseKey: string | undefined; sum: number; amount: number; count: number }) {
  const equal = sum === amount;
  return (
    <section className="min-w-0 rounded-[14px] border border-line-200 bg-white">
      <header className="flex items-center gap-2.5 border-b border-ground-100 px-4 py-3.5">
        <strong className="text-sm">Included paid calls</strong>
        <span className="rounded-md border border-line-200 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">AG STUDIO</span>
        <span className="ml-auto text-xs text-ink-500">Export CSV from the widget menu</span>
      </header>
      <div className="p-2">
        {rows.length === 0 ? (
          <p className="m-0 p-6 text-center text-sm text-ink-500">This charge covers no paid calls.</p>
        ) : (
          <PaidCallsStudio kind="charge" scope="operator" rows={rows} licenseKey={licenseKey} height={Math.min(560, 140 + rows.length * 44)} />
        )}
      </div>
      <table className="tbl">
        <tfoot>
          <tr>
            <td className="border-b-0 bg-ground-50 font-semibold">
              Sum of {count} paid call{count === 1 ? '' : 's'}
            </td>
            <td className="tnum border-b-0 bg-ground-50 text-right font-mono font-semibold">{formatUsd(sum)}</td>
          </tr>
          {equal ? (
            <tr>
              <td className="border-b-0 bg-meter-100 font-semibold text-meter-800">
                <span aria-hidden="true">✓ </span>Equals the charge amount
              </td>
              <td className="tnum border-b-0 bg-meter-100 text-right font-mono font-semibold text-meter-800">{formatUsd(amount)}</td>
            </tr>
          ) : (
            <tr>
              <td className="border-b-0 bg-red-100 font-semibold text-red-800">
                <span aria-hidden="true">✕ </span>Does not equal the charge amount ({formatUsd(amount)})
              </td>
              <td className="tnum border-b-0 bg-red-100 text-right font-mono font-semibold text-red-800">{formatUsd(amount)}</td>
            </tr>
          )}
        </tfoot>
      </table>
    </section>
  );
}
