import { createHash } from 'node:crypto';
import type { CommoditySymbol, Topic } from '../services';

/** Every data response says it is simulated (design spec §3.5). */
export const DEMO_SOURCE = 'Acme Data demo feed (simulated)';

export interface QuoteRow {
  symbol: CommoditySymbol;
  name: string;
  unit: string;
  base: number;
  topic: Topic;
}

export const QUOTE_ROWS: Record<CommoditySymbol, QuoteRow> = {
  KC: { symbol: 'KC', name: 'Coffee (Arabica) futures', unit: 'US cents per lb', base: 285.4, topic: 'coffee' },
  CC: { symbol: 'CC', name: 'Cocoa futures', unit: 'USD per metric ton', base: 7450.0, topic: 'cocoa' },
  SB: { symbol: 'SB', name: 'Sugar No. 11 futures', unit: 'US cents per lb', base: 19.85, topic: 'sugar' },
  CT: { symbol: 'CT', name: 'Cotton No. 2 futures', unit: 'US cents per lb', base: 68.2, topic: 'cotton' },
};

const DAY_MS = 86_400_000;
const MAX_MOVE = 0.04;

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Rounds a market price to 2 decimals. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The day's move `d` in [-0.04, +0.04], from SHA-256 of `"<YYYY-MM-DD>|<symbol>"`: the first four
 * bytes as an unsigned integer, scaled to the range.
 */
export function dailyMove(date: string, symbol: CommoditySymbol): number {
  const digest = createHash('sha256').update(`${date}|${symbol}`).digest();
  const unit = digest.readUInt32BE(0) / 0xffffffff;
  return (unit * 2 - 1) * MAX_MOVE;
}

/** The simulated price of `symbol` on a UTC day. */
export function priceOn(date: string, symbol: CommoditySymbol): number {
  return round2(QUOTE_ROWS[symbol].base * (1 + dailyMove(date, symbol)));
}

export interface Quote {
  symbol: CommoditySymbol;
  name: string;
  unit: string;
  currency: 'USD';
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  asOf: string;
}

/** The quote at `nowMs`: deterministic per UTC day; `asOf` is truncated to the minute. */
export function quoteAt(symbol: CommoditySymbol, nowMs: number): Quote {
  const row = QUOTE_ROWS[symbol];
  const price = priceOn(utcDate(nowMs), symbol);
  const previousClose = priceOn(utcDate(nowMs - DAY_MS), symbol);
  const change = round2(price - previousClose);
  return {
    symbol,
    name: row.name,
    unit: row.unit,
    currency: 'USD',
    price,
    previousClose,
    change,
    changePercent: round2((change / previousClose) * 100),
    asOf: new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString(),
  };
}
