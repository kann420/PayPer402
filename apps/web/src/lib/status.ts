/**
 * The status vocabulary (design spec §8.4): one table, rendered by one `StatusBadge`. Each entry
 * pairs a tone with a glyph and a label, so a status never relies on colour alone.
 */

export type Tone = 'ok' | 'pending' | 'warn' | 'bad' | 'neutral';

export interface StatusEntry {
  label: string;
  glyph: string;
  tone: Tone;
}

export const TONES: Record<Tone, { background: string; ink: string }> = {
  ok: { background: '#DDF9E9', ink: '#05592C' },
  pending: { background: '#ECE8FF', ink: '#3A2799' },
  warn: { background: '#FFF1D6', ink: '#6B4200' },
  bad: { background: '#FDE7E4', ink: '#8A1C12' },
  neutral: { background: '#EEF0EB', ink: '#3A423E' },
};

export const WALLET_STATUSES = [
  'not_linked',
  'waiting_for_approval',
  'active',
  'unlinking',
  'stopped_by_payer',
  'link_failed',
] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

export const AGENT_STATUSES = ['active', 'paused'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const CALL_STATES = ['unsettled', 'settling', 'settled', 'uncollectable'] as const;
export type CallState = (typeof CALL_STATES)[number];

export const SETTLEMENT_STATUSES = ['pending', 'completed', 'failed', 'needs_review'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_TRIGGERS = ['threshold', 'daily', 'manual', 'unlink', 'relink'] as const;
export type SettlementTrigger = (typeof SETTLEMENT_TRIGGERS)[number];

export const BLOCK_REASONS = ['wallet_not_active', 'daily', 'total', 'unsettled'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const WALLET_STATUS: Record<WalletStatus, StatusEntry> = {
  not_linked: { label: 'Not linked', glyph: '○', tone: 'neutral' },
  waiting_for_approval: { label: 'Waiting for approval', glyph: '↻', tone: 'pending' },
  active: { label: 'Active', glyph: '✓', tone: 'ok' },
  unlinking: { label: 'Unlinking…', glyph: '↻', tone: 'pending' },
  stopped_by_payer: { label: 'Stopped by payer', glyph: '⊘', tone: 'bad' },
  link_failed: { label: 'Link failed', glyph: '✕', tone: 'bad' },
};

export const AGENT_STATUS: Record<AgentStatus | 'blocked', StatusEntry> = {
  active: { label: 'Active', glyph: '●', tone: 'ok' },
  paused: { label: 'Paused', glyph: '❙❙', tone: 'neutral' },
  blocked: { label: 'Blocked', glyph: '⊘', tone: 'bad' },
};

export const CALL_STATE: Record<CallState, StatusEntry> = {
  unsettled: { label: 'Not yet charged', glyph: '◷', tone: 'pending' },
  settling: { label: 'Charging', glyph: '↻', tone: 'warn' },
  settled: { label: 'Charged', glyph: '✓', tone: 'ok' },
  uncollectable: { label: 'Not collected', glyph: '✕', tone: 'bad' },
};

export const SETTLEMENT_STATUS: Record<SettlementStatus, StatusEntry> = {
  pending: { label: 'Charging', glyph: '↻', tone: 'warn' },
  completed: { label: 'Completed', glyph: '✓', tone: 'ok' },
  failed: { label: 'Failed', glyph: '✕', tone: 'bad' },
  needs_review: { label: 'Needs review', glyph: '!', tone: 'warn' },
};

export const TRIGGER: Record<SettlementTrigger, { label: string; legend: string }> = {
  threshold: { label: 'Threshold', legend: 'unpaid usage neared Auto-charge at' },
  daily: { label: 'Daily', legend: 'once a day, after midnight UTC' },
  manual: { label: 'Manual', legend: 'you pressed Charge now' },
  unlink: { label: 'Unlink', legend: 'final charge when you unlinked' },
  relink: { label: 'Re-link', legend: 'earlier usage collected when you re-linked' },
};

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  wallet_not_active: 'PayPal link not active',
  daily: 'Daily limit reached',
  total: 'Total limit reached',
  unsettled: 'Waiting for the PayPal charge',
};

export type StatusDomain = 'wallet' | 'agent' | 'call' | 'settlement';

/** The entry for a raw value of a domain; an unknown value gets a neutral badge with its own text. */
export function statusEntry(domain: StatusDomain, value: string): StatusEntry {
  const table: Record<string, StatusEntry> =
    domain === 'wallet' ? WALLET_STATUS : domain === 'agent' ? AGENT_STATUS : domain === 'call' ? CALL_STATE : SETTLEMENT_STATUS;
  return Object.hasOwn(table, value) ? (table[value] as StatusEntry) : { label: value, glyph: '•', tone: 'neutral' };
}

/** A paid-call label back to its entry (Studio rows carry the label, not the raw state). */
export function callEntryByLabel(label: string): StatusEntry | undefined {
  return Object.values(CALL_STATE).find((entry) => entry.label === label);
}

export function isBlockReason(value: unknown): value is BlockReason {
  return typeof value === 'string' && (BLOCK_REASONS as readonly string[]).includes(value);
}

/**
 * The agent badge rule: Paused first, then Blocked (with the reason as the tooltip), else Active.
 */
export function agentBadge(status: string, blockReason: string | null | undefined): StatusEntry & { tooltip?: string } {
  if (status === 'paused') return AGENT_STATUS.paused;
  if (isBlockReason(blockReason)) return { ...AGENT_STATUS.blocked, tooltip: BLOCK_REASON_TEXT[blockReason] };
  return AGENT_STATUS.active;
}

export function triggerLabel(trigger: string): string {
  return Object.hasOwn(TRIGGER, trigger) ? TRIGGER[trigger as SettlementTrigger].label : trigger;
}
