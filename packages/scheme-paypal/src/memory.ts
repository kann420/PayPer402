import { kidFromPublicKeyX } from './keys';
import {
  assertValidCaps,
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
} from './stores';

/** In-memory `AgentRegistry` for tests and local runs. */
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly agentsByKid = new Map<string, AgentRecord>();
  private readonly operators = new Map<string, OperatorRecord>();

  /**
   * Adds an operator. Throws if the operator id is already registered or any cap is not a safe
   * non-negative integer.
   */
  addOperator(operator: OperatorRecord): this {
    if (this.operators.has(operator.operatorId)) {
      throw new Error(`Operator already registered: ${operator.operatorId}`);
    }
    assertValidCaps(operator.caps);
    this.operators.set(operator.operatorId, structuredClone(operator));
    return this;
  }

  /**
   * Adds an agent key. Throws if `kid` is not derived from `publicKeyX` or is already registered.
   */
  addAgent(agent: AgentRecord): this {
    if (agent.kid !== kidFromPublicKeyX(agent.publicKeyX)) {
      throw new Error('Agent kid does not match its public key');
    }
    if (this.agentsByKid.has(agent.kid)) {
      throw new Error(`Agent kid already registered: ${agent.kid}`);
    }
    this.agentsByKid.set(agent.kid, { ...agent });
    return this;
  }

  /** Changes an operator's wallet status, for example to `revoked`. */
  setWalletStatus(operatorId: string, walletStatus: OperatorRecord['walletStatus']): void {
    const operator = this.operators.get(operatorId);
    if (!operator) throw new Error(`Unknown operator: ${operatorId}`);
    operator.walletStatus = walletStatus;
  }

  setCaps(operatorId: string, caps: Caps): void {
    const operator = this.operators.get(operatorId);
    if (!operator) throw new Error(`Unknown operator: ${operatorId}`);
    assertValidCaps(caps);
    operator.caps = { ...caps };
  }

  setAgentStatus(kid: string, status: AgentRecord['status']): void {
    const agent = this.agentsByKid.get(kid);
    if (!agent) throw new Error(`Unknown agent kid: ${kid}`);
    agent.status = status;
  }

  async getAgentByKid(kid: string): Promise<AgentRecord | undefined> {
    const agent = this.agentsByKid.get(kid);
    return agent ? { ...agent } : undefined;
  }

  async getOperator(operatorId: string): Promise<OperatorRecord | undefined> {
    const operator = this.operators.get(operatorId);
    return operator ? structuredClone(operator) : undefined;
  }
}

/**
 * In-memory `CommitmentLedger`. `record` checks and inserts synchronously, with no `await` in
 * between, so concurrent calls cannot both pass the cap check.
 */
export class InMemoryCommitmentLedger implements CommitmentLedger {
  private readonly records = new Map<string, CommitmentRecord>();

  async has(id: string): Promise<boolean> {
    return this.records.has(id);
  }

  async get(id: string): Promise<CommitmentRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  /** All records, in insertion order (copies). */
  all(): CommitmentRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Number of recorded commitments. */
  get size(): number {
    return this.records.size;
  }

  /** Changes a record's state, as a redemption job would. */
  setState(id: string, state: CommitmentRecord['state']): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown commitment: ${id}`);
    record.state = state;
  }

  async snapshot(operatorId: string, nowSeconds: number): Promise<SpendSnapshot> {
    return this.snapshotSync(operatorId, nowSeconds);
  }

  async record(entry: Omit<CommitmentRecord, 'state'>, caps: Caps, nowSeconds: number): Promise<RecordResult> {
    // Everything below is synchronous: the check and the insert form one atomic step.
    const existing = this.records.get(entry.id);
    if (existing) {
      if (existing.payloadHash !== entry.payloadHash) return { ok: false, reason: 'replay' };
      return {
        ok: true,
        record: { ...existing },
        duplicate: true,
        snapshot: this.snapshotSync(existing.operatorId, nowSeconds),
      };
    }
    const before = this.snapshotSync(entry.operatorId, nowSeconds);
    const cap = exceededCap(entry.amount, before, caps);
    if (cap) return { ok: false, reason: 'cap_exceeded', cap };
    const record: CommitmentRecord = { ...entry, state: 'unsettled' };
    this.records.set(record.id, record);
    return {
      ok: true,
      record: { ...record },
      duplicate: false,
      snapshot: this.snapshotSync(entry.operatorId, nowSeconds),
    };
  }

  private snapshotSync(operatorId: string, nowSeconds: number): SpendSnapshot {
    const dayStart = utcDayStart(nowSeconds);
    const dayEnd = dayStart + 86_400;
    let spentToday = 0;
    let unsettled = 0;
    let spentTotal = 0;
    for (const record of this.records.values()) {
      if (record.operatorId !== operatorId) continue;
      spentTotal += record.amount;
      if (record.recordedAt >= dayStart && record.recordedAt < dayEnd) spentToday += record.amount;
      if (record.state === 'unsettled' || record.state === 'settling') unsettled += record.amount;
    }
    return { spentToday, unsettled, spentTotal };
  }
}
