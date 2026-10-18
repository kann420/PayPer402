/** Seller KPIs from the seller's paid calls and settlements (design spec §10.11). */
import { DAY_SECONDS, weekRevenue } from './rows';
import { utcDayStart } from './time';

export interface SellerKpis {
  revenueWeek: number;
  /** Today's revenue against yesterday's, in percent; undefined without revenue yesterday. */
  changeVsYesterday: number | undefined;
}

export function sellerKpis(calls: { recordedAt: number; amount: number }[], revenueToday: number, now: number): SellerKpis {
  const today = utcDayStart(now);
  const yesterday = calls.filter((c) => c.recordedAt >= today - DAY_SECONDS && c.recordedAt < today).reduce((n, c) => n + c.amount, 0);
  return {
    revenueWeek: weekRevenue(calls, now),
    changeVsYesterday: yesterday === 0 ? undefined : Math.round(((revenueToday - yesterday) / yesterday) * 100),
  };
}

export interface WeeklySettled {
  gross: number;
  fees: number;
  net: number;
}

/** Gross, fees and net over the settlements of the last 7 UTC days (fees not yet known count as 0). */
export function weeklySettled(settlements: { createdAt: number; sellerAmount: number; feeShare: number | null; status: string }[], now: number): WeeklySettled {
  const from = utcDayStart(now) - 6 * DAY_SECONDS;
  const week = settlements.filter((s) => s.createdAt >= from && s.status === 'completed');
  const gross = week.reduce((n, s) => n + s.sellerAmount, 0);
  const fees = week.reduce((n, s) => n + (s.feeShare ?? 0), 0);
  return { gross, fees, net: gross - fees };
}
