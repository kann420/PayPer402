/**
 * The limits form (design spec §10.4): one pure parser and validator shared by onboarding step 2
 * and Settings. Values are dollars with at most two decimals, up to $10,000.00.
 */
export const MAX_CAP_CENTS = 1_000_000;

export interface CapsInput {
  perCall: string;
  daily: string;
  total: string;
  noTotal: boolean;
  autoCharge: string;
}

export type CapsField = 'perCall' | 'daily' | 'total' | 'autoCharge';

export interface CapsPayload {
  perCall: number;
  daily: number;
  unsettled: number;
  total: number | null;
}

export type CapsResult = { ok: true; caps: CapsPayload } | { ok: false; errors: Partial<Record<CapsField, string>> };

const DOLLARS = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/** Dollars to cents, or a message. */
export function parseDollars(value: string): number | string {
  const trimmed = value.trim().replace(/^\$/, '').replace(/,/g, '');
  if (trimmed === '') return 'Enter an amount.';
  const match = DOLLARS.exec(trimmed);
  if (!match) return 'Use a dollar amount with at most 2 decimals, like 5.00.';
  const whole = match[1] as string;
  if (whole.length > 6) return 'The most you can set is $10,000.00.';
  const cents = Number(whole) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents > MAX_CAP_CENTS) return 'The most you can set is $10,000.00.';
  return cents;
}

export function validateCaps(input: CapsInput): CapsResult {
  const errors: Partial<Record<CapsField, string>> = {};
  const perCall = parseDollars(input.perCall);
  const daily = parseDollars(input.daily);
  const autoCharge = parseDollars(input.autoCharge);
  const total = input.noTotal ? null : parseDollars(input.total);
  if (typeof perCall === 'string') errors.perCall = perCall;
  if (typeof daily === 'string') errors.daily = daily;
  if (typeof autoCharge === 'string') errors.autoCharge = autoCharge;
  if (typeof total === 'string') errors.total = total;

  if (typeof perCall === 'number') {
    if (perCall < 1) errors.perCall = 'Max per call must be at least $0.01';
    else if (typeof daily === 'number' && perCall > daily) errors.perCall = "Max per call can't be higher than the daily limit";
    else if (typeof autoCharge === 'number' && perCall > autoCharge) errors.perCall = "Max per call can't be higher than Auto-charge at";
    if (typeof total === 'number' && perCall >= 1 && total < perCall) errors.total = "The total limit can't be lower than Max per call";
  }
  if (typeof daily === 'number' && daily < 1 && errors.daily === undefined) errors.daily = 'The daily limit must be at least $0.01';
  if (typeof autoCharge === 'number' && autoCharge < 1 && errors.autoCharge === undefined) errors.autoCharge = 'Auto-charge at must be at least $0.01';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, caps: { perCall: perCall as number, daily: daily as number, unsettled: autoCharge as number, total: total as number | null } };
}

/** Facilitator caps (cents) to form values (dollars). */
export function capsToInput(caps: { perCall: number; daily: number; unsettled: number; total?: number | undefined }): CapsInput {
  const d = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  return {
    perCall: d(caps.perCall),
    daily: d(caps.daily),
    total: caps.total === undefined ? '' : d(caps.total),
    noTotal: caps.total === undefined,
    autoCharge: d(caps.unsettled),
  };
}

/** A facilitator 400 `issues` list back to the form fields (`unsettled` is Auto-charge at). */
export function issuesToFields(issues: { path: string; message: string }[]): Partial<Record<CapsField, string>> {
  const fields: Partial<Record<CapsField, string>> = {};
  for (const issue of issues) {
    const field: CapsField = issue.path === 'unsettled' ? 'autoCharge' : issue.path === 'daily' ? 'daily' : issue.path === 'total' ? 'total' : 'perCall';
    fields[field] ??= issue.message;
  }
  return fields;
}

/** The preview sentence (fixes §1.4). */
export function previewSentence(caps: CapsPayload): string {
  const usd = (c: number) => `$${Math.floor(c / 100).toLocaleString('en-US')}.${String(c % 100).padStart(2, '0')}`;
  return `Your agents can spend up to ${usd(caps.daily)} a day. We charge your PayPal account when unpaid usage nears ${usd(caps.unsettled)}, and at least once a day.`;
}
