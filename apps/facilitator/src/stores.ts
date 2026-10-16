import {
  exceededCap,
  utcDayStart,
  type AgentRecord,
  type AgentRegistry,
  type Caps,
  type CommitmentLedger,
  type CommitmentRecord,
  type OperatorRecord,
  type RecordResult,
  type SpendSnapshot,
  type WalletStatus,
} from '@payper402/scheme-paypal';
import type { Db } from './db/connection';
import type { AgentRow, CommitmentRow, OperatorRow, WalletStatusRow } from './db/rows';
import { errorMessage, type Logger } from './logger';

/** Maps a wallet row status to the scheme's wallet status (design spec §6). */
export function schemeWalletStatus(status: WalletStatusRow | undefined): WalletStatus {
  if (status === 'active') return 'active';
  if (status === 'stopped_by_payer') return 'revoked';
  return 'unlinked';
}

export function capsOf(row: OperatorRow): Caps {
  const caps: Caps = { perCall: row.cap_per_call, daily: row.cap_daily, unsettled: row.cap_unsettled };
  if (row.cap_total !== null) caps.total = row.cap_total;
  return caps;
}

/** Spend snapshot with the scheme's definitions. Synchronous, for use inside transactions. */
export function snapshotSync(db: Db, operatorId: string, nowSeconds: number): SpendSnapshot {
  const dayStart = utcDayStart(nowSeconds);
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(amount), 0) AS spentTotal,
         COALESCE(SUM(CASE WHEN recorded_at >= @dayStart AND recorded_at < @dayEnd THEN amount ELSE 0 END), 0) AS spentToday,
         COALESCE(SUM(CASE WHEN state IN ('unsettled', 'settling') THEN amount ELSE 0 END), 0) AS unsettled
       FROM commitments WHERE operator_id = @operatorId`,
    )
    .get({ operatorId, dayStart, dayEnd: dayStart + 86_400 }) as SpendSnapshot;
  return { spentToday: row.spentToday, unsettled: row.unsettled, spentTotal: row.spentTotal };
}

export function toCommitmentRecord(row: CommitmentRow): CommitmentRecord {
  return {
    id: row.id,
    kid: row.kid,
    agentId: row.agent_id,
    operatorId: row.operator_id,
    payTo: row.pay_to,
    resourceUrl: row.resource_url,
    maxAmount: row.max_amount,
    amount: row.amount,
    iat: row.iat,
    recordedAt: row.recorded_at,
    state: row.state,
    payloadHash: row.payload_hash,
  };
}

/** `AgentRegistry` over the `agents`, `operators` and `wallets` tables. */
export class SqliteAgentRegistry implements AgentRegistry {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async getAgentByKid(kid: string): Promise<AgentRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM agents WHERE kid = ?').get(kid) as AgentRow | undefined;
    if (!row) return undefined;
    return {
      agentId: row.id,
      kid: row.kid,
      publicKeyX: row.public_key_x,
      operatorId: row.operator_id,
      status: row.status === 'active' ? 'active' : 'disabled',
    };
  }

  async getOperator(operatorId: string): Promise<OperatorRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT o.*, w.status AS wallet_status FROM operators o
         LEFT JOIN wallets w ON w.operator_id = o.id WHERE o.id = ?`,
      )
      .get(operatorId) as (OperatorRow & { wallet_status: WalletStatusRow | null }) | undefined;
    if (!row) return undefined;
    return { operatorId: row.id, walletStatus: schemeWalletStatus(row.wallet_status ?? undefined), caps: capsOf(row) };
  }
}

export type OnRecorded = (record: CommitmentRecord) => void;

/**
 * `CommitmentLedger` over the `commitments` table. `record` runs as one IMMEDIATE transaction;
 * better-sqlite3 is synchronous, so the cap check and the insert are atomic within the process.
 * `onRecorded` fires only for new inserts, after the commit, with errors caught.
 */
export class SqliteCommitmentLedger implements CommitmentLedger {
  private readonly db: Db;
  private readonly onRecorded: OnRecorded | undefined;
  private readonly logger: Logger | undefined;
  private readonly recordTx: (entry: Omit<CommitmentRecord, 'state'>, caps: Caps, now: number) => RecordResult;

  constructor(db: Db, onRecorded?: OnRecorded, logger?: Logger) {
    this.db = db;
    this.onRecorded = onRecorded;
    this.logger = logger;
    const select = db.prepare('SELECT * FROM commitments WHERE id = ?');
    const insert = db.prepare(
      `INSERT INTO commitments
         (id, kid, agent_id, operator_id, pay_to, resource_url, max_amount, amount, iat, recorded_at, state, payload_hash)
       VALUES
         (@id, @kid, @agentId, @operatorId, @payTo, @resourceUrl, @maxAmount, @amount, @iat, @recordedAt, 'unsettled', @payloadHash)`,
    );
    const tx = db.transaction((entry: Omit<CommitmentRecord, 'state'>, caps: Caps, now: number): RecordResult => {
      const existing = select.get(entry.id) as CommitmentRow | undefined;
      if (existing) {
        if (existing.payload_hash !== entry.payloadHash) return { ok: false, reason: 'replay' };
        return {
          ok: true,
          duplicate: true,
          record: toCommitmentRecord(existing),
          snapshot: snapshotSync(db, existing.operator_id, now),
        };
      }
      const cap = exceededCap(entry.amount, snapshotSync(db, entry.operatorId, now), caps);
      if (cap) return { ok: false, reason: 'cap_exceeded', cap };
      insert.run(entry);
      return {
        ok: true,
        duplicate: false,
        record: { ...entry, state: 'unsettled' },
        snapshot: snapshotSync(db, entry.operatorId, now),
      };
    });
    this.recordTx = (entry, caps, now) => tx.immediate(entry, caps, now);
  }

  async has(id: string): Promise<boolean> {
    return this.db.prepare('SELECT 1 FROM commitments WHERE id = ?').get(id) !== undefined;
  }

  async get(id: string): Promise<CommitmentRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as CommitmentRow | undefined;
    return row ? toCommitmentRecord(row) : undefined;
  }

  async snapshot(operatorId: string, nowSeconds: number): Promise<SpendSnapshot> {
    return snapshotSync(this.db, operatorId, nowSeconds);
  }

  async record(entry: Omit<CommitmentRecord, 'state'>, caps: Caps, nowSeconds: number): Promise<RecordResult> {
    const result = this.recordTx(entry, caps, nowSeconds);
    if (result.ok && !result.duplicate && this.onRecorded) {
      try {
        this.onRecorded({ ...result.record });
      } catch (err) {
        this.logger?.error('onRecorded hook failed', { commitmentId: entry.id, error: errorMessage(err) });
      }
    }
    return result;
  }
}
