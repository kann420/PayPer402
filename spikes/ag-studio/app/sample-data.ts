// Sample paid calls shaped like the Overview mockup: 14 days ending Nov 2, 2026, three agents and
// three services. Deterministic, so screenshots compare run to run.

export type PaidCallStatus = 'Not yet charged' | 'Charged' | 'Charging' | 'Not collected';

export interface PaidCallRow {
  id: string;
  time: string; // ISO 8601 wall-clock time, no zone
  day: string; // YYYY-MM-DD
  agent: string;
  service: string;
  endpoint: string;
  price: number; // USD
  status: PaidCallStatus;
}

// Daily spend read off the mockup's line chart (Oct 20 to Nov 2; Nov 2 is today, partial).
const DAILY_SPEND = [3.1, 4.2, 2.8, 5.6, 4.9, 3.7, 6.2, 5.1, 4.4, 7.0, 5.8, 6.3, 8.1, 2.46];
const FIRST_DAY = Date.UTC(2026, 9, 20);
const DAY_MS = 86_400_000;
const LAST_CHARGE_AT = Date.UTC(2026, 10, 2, 9, 14);

const SERVICES = [
  { service: 'Page Summary API', endpoint: () => 'POST /v1/summarize', price: 0.05, share: 0.52 },
  {
    service: 'Market Quote API',
    endpoint: (r: number) => `GET /v1/quote?symbol=${['KC', 'CC', 'SB'][Math.floor(r * 3)]}`,
    price: 0.02,
    share: 0.31,
  },
  { service: 'Translate API', endpoint: () => 'POST /v1/translate', price: 0.01, share: 0.17 },
] as const;

const AGENTS = [
  { agent: 'research-bot', weight: 0.7 },
  { agent: 'price-watcher', weight: 0.24 },
  { agent: 'translator-01', weight: 0.06 },
] as const;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wall-clock time without a zone, so the mockup's 10:42 shows as 10:42 in any browser.
function localIso(at: number): string {
  return new Date(at).toISOString().slice(0, 19);
}

function pickAgent(r: number, isToday: boolean): string {
  // translator-01 is paused today, as in the mockup.
  const pool = isToday ? AGENTS.filter((a) => a.agent !== 'translator-01') : AGENTS;
  const total = pool.reduce((s, a) => s + a.weight, 0);
  let x = r * total;
  for (const a of pool) {
    if ((x -= a.weight) <= 0) return a.agent;
  }
  return pool[0]!.agent;
}

export function buildPaidCalls(): PaidCallRow[] {
  const rand = mulberry32(402);
  const rows: PaidCallRow[] = [];
  DAILY_SPEND.forEach((spend, dayIndex) => {
    const dayStart = FIRST_DAY + dayIndex * DAY_MS;
    const isToday = dayIndex === DAILY_SPEND.length - 1;
    // Today runs until 10:40; earlier days run 07:00 to 23:00.
    const from = dayStart + 7 * 3_600_000;
    const to = isToday ? dayStart + (10 * 60 + 40) * 60_000 : dayStart + 23 * 3_600_000;
    for (const s of SERVICES) {
      const count = Math.round((spend * s.share) / s.price);
      for (let i = 0; i < count; i++) {
        const at = from + Math.floor(rand() * (to - from));
        rows.push({
          id: '',
          time: localIso(at),
          day: new Date(dayStart).toISOString().slice(0, 10),
          agent: pickAgent(rand(), isToday),
          service: s.service,
          endpoint: s.endpoint(rand()),
          price: s.price,
          status: at > LAST_CHARGE_AT ? 'Not yet charged' : 'Charged',
        });
      }
    }
  });

  // The three calls the mockup's table starts with.
  const today = '2026-11-02';
  rows.push(
    { id: '', time: `${today}T10:42:07`, day: today, agent: 'research-bot', service: 'Market Quote API', endpoint: 'GET /v1/quote?symbol=KC', price: 0.02, status: 'Not yet charged' },
    { id: '', time: `${today}T10:42:09`, day: today, agent: 'research-bot', service: 'Page Summary API', endpoint: 'POST /v1/summarize', price: 0.05, status: 'Not yet charged' },
    { id: '', time: `${today}T10:42:12`, day: today, agent: 'research-bot', service: 'Translate API', endpoint: 'POST /v1/translate', price: 0.01, status: 'Not yet charged' },
  );

  rows.sort((a, b) => b.time.localeCompare(a.time));
  rows.forEach((r, i) => {
    r.id = `cmt_${String(rows.length - i).padStart(5, '0')}`;
  });
  return rows;
}
