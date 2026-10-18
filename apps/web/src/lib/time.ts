/** Times (design spec §8.3). Every time and day shown is UTC; the facilitator uses unix seconds. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const at = (seconds: number) => new Date(seconds * 1000);

/** `HH:MM:SS`. */
export function formatTime(seconds: number): string {
  const d = at(seconds);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** `Nov 2, 09:14`. */
export function formatDateTime(seconds: number): string {
  const d = at(seconds);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `Nov 2, 2026`. */
export function formatDate(seconds: number): string {
  const d = at(seconds);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** `Nov 2`. */
export function formatShortDate(seconds: number): string {
  const d = at(seconds);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** `YYYY-MM-DDTHH:MM:SS`, UTC, no zone (AG Studio rows). */
export function isoTime(seconds: number): string {
  return at(seconds).toISOString().slice(0, 19);
}

/** `YYYY-MM-DD`, the UTC day. */
export function isoDay(seconds: number): string {
  return at(seconds).toISOString().slice(0, 10);
}

/** Start of the UTC day, in unix seconds. */
export function utcDayStart(seconds: number): number {
  return Math.floor(seconds / 86_400) * 86_400;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** "Last call": the time for today (UTC), the short date for earlier days, "—" for none. */
export function lastCall(at: number | null, now: number): string {
  if (at === null) return '—';
  return at >= utcDayStart(now) ? formatTime(at) : formatShortDate(at);
}
