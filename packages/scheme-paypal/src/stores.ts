/**
 * Storage interfaces the facilitator scheme depends on. Phase 1 ships in-memory versions
 * (`memory.ts`); a database-backed facilitator implements the same interfaces.
 */

export type WalletStatus = 'active' | 'revoked' | 'unlinked';
export type CapName = 'perCall' | 'daily' | 'unsettled' | 'total';

/** Spending caps of one operator. All amounts are cents. */
export interface Caps {
  /** Most a single commitment may record. */
  perCall: number;
  /** Per UTC day of `recordedAt`, settled and unsettled usage together. */
  daily: number;
  /** Most that may be recorded but not yet redeemed. */
  unsettled: number;
  /** Lifetime total, optional. */
  total?: number;
}

export interface AgentRecord {
  agentId: string;
  kid: string;
  /** Raw Ed25519 public key, base64url without padding. */
  publicKeyX: string;
  operatorId: string;
  status: 'active' | 'disabled';
}

export interface OperatorRecord {
  operatorId: string;
  walletStatus: WalletStatus;
  caps: Caps;
}

export interface AgentRegistry {
  getAgentByKid(kid: string): Promise<AgentRecord | undefined>;
  getOperator(operatorId: string): Promise<OperatorRecord | undefined>;
}

/** Spend of one operator at a point in time. All amounts are cents. */
export interface SpendSnapshot {
  /** Recorded during the current UTC day, any state. */
  spentToday: number;
  /** Recorded and not yet redeemed (`unsettled` or `settling`). */
  unsettled: number;
  /** Recorded ever, any state. */
  spentTotal: number;
}

export interface CommitmentRecord {
  id: string;
  kid: string;
  agentId: string;
  operatorId: string;
  payTo: string;
  resourceUrl: string;
  /** Cents, as signed. */
  maxAmount: number;
  /** Cents, actually charged. */
  amount: number;
  iat: number;
  /** Unix seconds. */
  recordedAt: number;
  state: 'unsettled' | 'settling' | 'settled' | 'uncollectable';
  payloadHash: string;
}

export type RecordResult =
  | { ok: true; record: CommitmentRecord; duplicate: boolean; snapshot: SpendSnapshot }
  | { ok: false; reason: 'replay' }
  | { ok: false; reason: 'cap_exceeded'; cap: CapName };

export interface CommitmentLedger {
  has(id: string): Promise<boolean>;
  get(id: string): Promise<CommitmentRecord | undefined>;
  snapshot(operatorId: string, nowSeconds: number): Promise<SpendSnapshot>;
  /**
   * Atomic. If `id` exists: same payloadHash → { ok: true, duplicate: true, original record };
   * different payloadHash → replay. Otherwise check caps with entry.amount, then insert.
   */
  record(entry: Omit<CommitmentRecord, 'state'>, caps: Caps, nowSeconds: number): Promise<RecordResult>;
}

/**
 * Returns the first cap (in binding-spec order: perCall, daily, unsettled, total) that recording
 * `amount` on top of `snapshot` would exceed, or `undefined` when all hold.
 */
export function exceededCap(amount: number, snapshot: SpendSnapshot, caps: Caps): CapName | undefined {
  // Written as !(x <= cap) so that NaN or a missing cap fails closed.
  if (!(amount <= caps.perCall)) return 'perCall';
  if (!(snapshot.spentToday + amount <= caps.daily)) return 'daily';
  if (!(snapshot.unsettled + amount <= caps.unsettled)) return 'unsettled';
  if (caps.total !== undefined && !(snapshot.spentTotal + amount <= caps.total)) return 'total';
  return undefined;
}

/** Throws unless every cap is a safe non-negative integer (cents); `total` may be omitted. */
export function assertValidCaps(caps: Caps): void {
  if (caps === null || typeof caps !== 'object') {
    throw new TypeError('Caps must be an object with perCall, daily and unsettled cents');
  }
  const names: CapName[] = ['perCall', 'daily', 'unsettled'];
  if (caps.total !== undefined) names.push('total');
  for (const name of names) {
    const value: unknown = caps[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Cap ${name} must be a safe non-negative integer of cents`);
    }
  }
}

/** Start of the UTC calendar day containing `nowSeconds`, in unix seconds. */
export function utcDayStart(nowSeconds: number): number {
  return Math.floor(nowSeconds / 86_400) * 86_400;
}
