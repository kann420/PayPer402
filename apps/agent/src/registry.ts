/**
 * The per-session call registry (decision-layer spec §3.1). In memory, one record per paid call
 * that reached the reservation. It backs the exact-duplicate and repeat rules (§3.2) and the
 * earlier results that Jev sees (§4.1).
 */
import { EARLIER_MAX, type BlockedCheck, type SpendRule } from './spend-check';

export type CallState = 'in_flight' | 'paid' | 'uncertain' | 'closed';

/** The code and check of a Jev block that closed a record. */
export interface JevRefusal {
  code: SpendRule;
  check: BlockedCheck;
}

export interface CallRecord {
  readonly callId: string;
  readonly serviceId: string;
  readonly key: string;
  state: CallState;
  /** Response data, kept only for the last `EARLIER_MAX` paid records. */
  data: unknown;
  hasData: boolean;
  jevRefusal?: JevRefusal;
}

export type RegistryMatch = { kind: 'repeat'; record: CallRecord } | { kind: 'duplicate'; record: CallRecord };

/** `serviceId` plus the params as JSON with sorted keys. Params are flat, so sorting the top level is enough. */
export function canonicalKey(serviceId: string, params: Record<string, string | number>): string {
  const sorted: Record<string, string | number> = {};
  for (const name of Object.keys(params).sort()) sorted[name] = params[name] as string | number;
  return `${serviceId}\n${JSON.stringify(sorted)}`;
}

export class CallRegistry {
  private readonly records: CallRecord[] = [];
  private readonly byId = new Map<string, CallRecord>();
  /** Paid records in the order they were paid. */
  private readonly paidOrder: CallRecord[] = [];

  /** A new `in_flight` record, created in the same synchronous block as the reservation. */
  open(callId: string, serviceId: string, key: string): void {
    if (this.byId.has(callId)) throw new Error(`call registry: ${callId} is already open`);
    const record: CallRecord = { callId, serviceId, key, state: 'in_flight', data: undefined, hasData: false };
    this.records.push(record);
    this.byId.set(callId, record);
  }

  paid(callId: string): void {
    this.move(callId, 'paid');
    this.paidOrder.push(this.get(callId));
  }

  uncertain(callId: string): void {
    this.move(callId, 'uncertain');
  }

  closed(callId: string, jevRefusal?: JevRefusal): void {
    this.move(callId, 'closed');
    if (jevRefusal !== undefined) this.get(callId).jevRefusal = jevRefusal;
  }

  /** Sets a paid record's data. Beyond `EARLIER_MAX` data holders, the oldest one's data is dropped. */
  setData(callId: string, data: unknown): void {
    const record = this.get(callId);
    if (record.state !== 'paid' || record.hasData) throw new Error(`call registry: ${callId} cannot take data in state ${record.state}`);
    record.data = data;
    record.hasData = true;
    const holders = this.paidOrder.filter((r) => r.hasData);
    for (const old of holders.slice(0, Math.max(0, holders.length - EARLIER_MAX))) {
      old.data = undefined;
      old.hasData = false;
    }
  }

  /** A Jev-closed record with this key (`repeat`), else an open, paid or uncertain one (`duplicate`). The most recent wins. */
  lookup(key: string): RegistryMatch | undefined {
    let duplicate: CallRecord | undefined;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i] as CallRecord;
      if (record.key !== key) continue;
      if (record.state === 'closed' && record.jevRefusal !== undefined) return { kind: 'repeat', record };
      if (duplicate === undefined && record.state !== 'closed') duplicate = record;
    }
    return duplicate === undefined ? undefined : { kind: 'duplicate', record: duplicate };
  }

  /** The last `EARLIER_MAX` paid records, oldest first, each with its data (possibly `undefined`). */
  earlier(): { callId: string; serviceId: string; data: unknown }[] {
    return this.paidOrder.slice(-EARLIER_MAX).map((r) => ({ callId: r.callId, serviceId: r.serviceId, data: r.hasData ? r.data : undefined }));
  }

  private get(callId: string): CallRecord {
    const record = this.byId.get(callId);
    if (!record) throw new Error(`call registry: unknown call ${callId}`);
    return record;
  }

  private move(callId: string, to: Exclude<CallState, 'in_flight'>): void {
    const record = this.get(callId);
    if (record.state !== 'in_flight') throw new Error(`call registry: ${callId} cannot move from ${record.state} to ${to}`);
    record.state = to;
  }
}
