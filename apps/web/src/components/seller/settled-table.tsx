import { formatUsd } from '@/lib/money';
import { statusEntry } from '@/lib/status';
import { formatDateTime } from '@/lib/time';
import { StatusBadge } from '../ui/status-badge';

export interface SettledRow {
  id: string;
  createdAt: number;
  status: string;
  sellerAmount: number;
  sellerCalls: number;
  feeShare: number | null;
  netShare: number | null;
}

export const SMALL_CHARGE_TIP = "PayPal's fixed fee is larger than this small charge.";

/** Date, Calls, Amount, PayPal fee, Net, Status (fixes §2.16). */
export function SettledTable({ rows }: { rows: SettledRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[14px] border border-line-200 bg-white">
      <table className="tbl">
        <thead>
          <tr>
            <th>Date</th>
            <th className="!text-right">Calls</th>
            <th className="!text-right">Amount</th>
            <th className="!text-right">PayPal fee</th>
            <th className="!text-right">Net</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="text-center text-sm text-ink-500">
                No charges yet.
              </td>
            </tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="tnum font-mono">{formatDateTime(r.createdAt)}</td>
              <td className="tnum text-right font-mono">{r.sellerCalls}</td>
              <td className="tnum text-right font-mono">{formatUsd(r.sellerAmount)}</td>
              <td className="tnum text-right font-mono text-ink-500">{r.feeShare === null ? '—' : formatUsd(-r.feeShare)}</td>
              <td
                className={`tnum text-right font-mono font-semibold ${r.netShare !== null && r.netShare < 0 ? 'text-red-800' : ''}`}
                title={r.netShare !== null && r.netShare < 0 ? SMALL_CHARGE_TIP : undefined}
              >
                {r.netShare === null ? '—' : formatUsd(r.netShare)}
                {r.netShare !== null && r.netShare < 0 ? <span className="sr-only"> ({SMALL_CHARGE_TIP})</span> : null}
              </td>
              <td>
                <StatusBadge entry={statusEntry('settlement', r.status)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
