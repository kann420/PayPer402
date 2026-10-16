import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { parsePayload, payloadHash, verifyCommitmentSignature, type Commitment } from './commitment';
import {
  ASSET,
  BINDING_VERSION,
  CLOCK_SKEW_SECONDS,
  MAX_TIMEOUT_SECONDS,
  SCHEME,
  PAYPAL_SANDBOX_NETWORK,
  SETTLE_GRACE_SECONDS,
  isPayPalNetwork,
} from './constants';
import { ErrorCode } from './errors';
import { parseCentsString, tryParseCentsString } from './money';
import {
  exceededCap,
  type AgentRecord,
  type AgentRegistry,
  type CapName,
  type CommitmentLedger,
  type CommitmentRecord,
  type OperatorRecord,
} from './stores';

export interface PayPalBatchFacilitatorSchemeOptions {
  agents: AgentRegistry;
  ledger: CommitmentLedger;
  /** Clock in unix seconds. Defaults to the system clock. */
  now?: () => number;
}

type Mode = 'verify' | 'settle';

interface Failure {
  ok: false;
  reason: ErrorCode;
  message: string;
  cap?: CapName;
}

interface Verified {
  ok: true;
  commitment: Commitment;
  signature: string;
  agent: AgentRecord;
  operator: OperatorRecord;
  /** Cents being verified (verify) or charged (settle). */
  amount: number;
  now: number;
}

const fail = (reason: ErrorCode, message: string, cap?: CapName): Failure =>
  cap === undefined ? { ok: false, reason, message } : { ok: false, reason, message, cap };

const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const systemNow = () => Math.floor(Date.now() / 1000);

/**
 * Facilitator side of the binding. `verify` runs binding-spec verification steps 1 to 8;
 * `settle` returns the original result for an identical retry; otherwise it re-runs steps 1 to 6
 * and records the commitment in the ledger. No money moves here:
 * redemption against PayPal happens later, in batches.
 */
export class PayPalBatchFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = 'paypal:*';
  private readonly agents: AgentRegistry;
  private readonly ledger: CommitmentLedger;
  private readonly now: () => number;

  constructor(options: PayPalBatchFacilitatorSchemeOptions) {
    this.agents = options.agents;
    this.ledger = options.ledger;
    this.now = options.now ?? systemNow;
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return { version: BINDING_VERSION };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const checked = await this.checkCommon(paymentPayload, requirements, 'verify');
    if (!checked.ok) return verifyFailure(checked);
    const { commitment, agent, operator, amount, now } = checked;

    // Step 7: replay.
    if (await this.ledger.has(commitment.id)) {
      return verifyFailure(fail(ErrorCode.replay, 'Commitment id already recorded'));
    }

    // Step 8: caps.
    const snapshot = await this.ledger.snapshot(operator.operatorId, now);
    const cap = exceededCap(amount, snapshot, operator.caps);
    if (cap) return verifyFailure(fail(ErrorCode.capExceeded, `The ${cap} cap would be exceeded`, cap));

    return {
      isValid: true,
      payer: agent.agentId,
      extra: { unsettledAmount: String(snapshot.unsettled), unsettledCap: String(operator.caps.unsettled) },
    };
  }

  async settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = responseNetwork(requirements);

    // Step 1 (shape only), then the idempotent-retry short-circuit: an identical payload whose id
    // is already recorded gets the original result back, before any check that depends on the
    // current time, wallet status or settle amount. This path is read-only.
    const parsed = parsePayload(paymentPayload?.payload);
    if (!parsed.ok) return settleFailure(fail(ErrorCode.payload, parsed.message), network);
    const existing = await this.ledger.get(parsed.payload.commitment.id);
    if (existing && existing.payloadHash === payloadHash(parsed.payload.commitment, parsed.payload.signature)) {
      const snapshot = await this.ledger.snapshot(existing.operatorId, this.now());
      return settleSuccess(existing, snapshot.unsettled);
    }

    const checked = await this.checkCommon(paymentPayload, requirements, 'settle');
    if (!checked.ok) return settleFailure(checked, network);
    const { commitment, signature, agent, operator, amount, now } = checked;

    const result = await this.ledger.record(
      {
        id: commitment.id,
        kid: commitment.kid,
        agentId: agent.agentId,
        operatorId: operator.operatorId,
        payTo: commitment.payTo,
        resourceUrl: typeof paymentPayload.resource?.url === 'string' ? paymentPayload.resource.url : '',
        maxAmount: parseCentsString(commitment.maxAmount),
        amount,
        iat: commitment.iat,
        recordedAt: now,
        payloadHash: payloadHash(commitment, signature),
      },
      operator.caps,
      now,
    );

    if (!result.ok) {
      if (result.reason === 'replay') {
        return settleFailure(fail(ErrorCode.replay, 'Commitment id already recorded with a different payload'), network);
      }
      return settleFailure(fail(ErrorCode.capExceeded, `The ${result.cap} cap would be exceeded`, result.cap), network);
    }

    return settleSuccess(result.record, result.snapshot.unsettled);
  }

  /** Binding-spec verification steps 1 to 6, with the settle variations when `mode` is settle. */
  private async checkCommon(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    mode: Mode,
  ): Promise<Verified | Failure> {
    // Step 1: payload shape.
    const parsed = parsePayload(paymentPayload?.payload);
    if (!parsed.ok) return fail(ErrorCode.payload, parsed.message);
    const { commitment, signature } = parsed.payload;
    if (requirements === null || typeof requirements !== 'object') {
      return fail(ErrorCode.payload, 'Payment requirements are missing');
    }

    const requiredAmount: unknown = requirements.amount;
    let amount: number;
    let maxAmountExpected: string;
    if (mode === 'verify') {
      const cents = tryParseCentsString(requiredAmount);
      if (cents === undefined) return fail(ErrorCode.payload, 'requirements.amount is not a valid cents string');
      amount = cents;
      maxAmountExpected = requiredAmount as string;
    } else {
      const accepted: unknown = paymentPayload.accepted?.amount;
      if (tryParseCentsString(accepted) === undefined) {
        return fail(ErrorCode.payload, 'accepted.amount is not a valid cents string');
      }
      if (typeof requiredAmount !== 'string' || !CANONICAL_INTEGER.test(requiredAmount)) {
        return fail(ErrorCode.payload, 'requirements.amount is not a base-10 integer string');
      }
      amount = Number(requiredAmount);
      maxAmountExpected = accepted as string;
    }

    // Step 2: requirements match.
    if (
      requirements.scheme !== SCHEME ||
      requirements.network !== PAYPAL_SANDBOX_NETWORK ||
      requirements.asset !== ASSET ||
      commitment.network !== requirements.network ||
      commitment.asset !== requirements.asset ||
      commitment.payTo !== requirements.payTo
    ) {
      return fail(ErrorCode.requirementsMismatch, 'Commitment does not match the payment requirements');
    }
    if (commitment.maxAmount !== maxAmountExpected) {
      return fail(
        ErrorCode.requirementsMismatch,
        mode === 'verify'
          ? 'commitment.maxAmount does not equal requirements.amount'
          : 'commitment.maxAmount does not equal accepted.amount',
      );
    }
    if (mode === 'settle') {
      const maxAmount = parseCentsString(commitment.maxAmount);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxAmount) {
        return fail(ErrorCode.amountExceedsCommitment, `Settle amount must be between 1 and ${maxAmount}`);
      }
    }

    // Step 3: freshness.
    const now = this.now();
    const timeout = requirements.maxTimeoutSeconds;
    const maxLifetime = Math.min(
      Number.isSafeInteger(timeout) && timeout > 0 ? timeout : MAX_TIMEOUT_SECONDS,
      MAX_TIMEOUT_SECONDS,
    );
    if (commitment.iat > now + CLOCK_SKEW_SECONDS) return fail(ErrorCode.expired, 'Commitment is not yet valid');
    if (commitment.exp <= commitment.iat || commitment.exp - commitment.iat > maxLifetime) {
      return fail(ErrorCode.expired, `Commitment lifetime must be between 1 and ${maxLifetime} seconds`);
    }
    const deadline = mode === 'verify' ? commitment.exp : commitment.exp + SETTLE_GRACE_SECONDS;
    if (now >= deadline) return fail(ErrorCode.expired, 'Commitment has expired');

    // Step 4: agent.
    const agent = await this.agents.getAgentByKid(commitment.kid);
    if (!agent) return fail(ErrorCode.unknownAgent, 'Agent key is not registered');
    if (agent.status !== 'active') return fail(ErrorCode.agentDisabled, 'Agent key is disabled');

    // Step 5: signature.
    if (!verifyCommitmentSignature(commitment, signature, agent.publicKeyX)) {
      return fail(ErrorCode.signature, 'Signature does not verify');
    }

    // Step 6: wallet.
    const operator = await this.agents.getOperator(agent.operatorId);
    if (!operator || operator.walletStatus === 'unlinked') {
      return fail(ErrorCode.walletNotLinked, 'Operator has no linked PayPal wallet');
    }
    if (operator.walletStatus !== 'active') {
      return fail(ErrorCode.walletRevoked, 'Operator revoked the PayPal billing agreement');
    }

    return { ok: true, commitment, signature, agent, operator, amount, now };
  }
}

/**
 * Network for settle responses. Only `paypal:sandbox` is ever settled; a malformed requirements
 * object must not make the facilitator throw.
 */
function responseNetwork(requirements: PaymentRequirements | null | undefined): Network {
  const network: unknown = requirements?.network;
  return typeof network === 'string' && isPayPalNetwork(network) ? network : PAYPAL_SANDBOX_NETWORK;
}

/** Success response for a recorded commitment, new or an identical retry. */
function settleSuccess(record: CommitmentRecord, unsettled: number): SettleResponse {
  const charged = String(record.amount);
  return {
    success: true,
    transaction: record.id,
    network: PAYPAL_SANDBOX_NETWORK,
    payer: record.agentId,
    amount: charged,
    // Informational. On a retry, unsettledAmount reflects the current ledger, not the original.
    extra: { chargedAmount: charged, unsettledAmount: String(unsettled) },
  };
}

function verifyFailure(failure: Failure): VerifyResponse {
  const response: VerifyResponse = {
    isValid: false,
    invalidReason: failure.reason,
    invalidMessage: failure.message,
  };
  if (failure.cap !== undefined) response.extra = { cap: failure.cap };
  return response;
}

function settleFailure(failure: Failure, network: Network): SettleResponse {
  const response: SettleResponse = {
    success: false,
    errorReason: failure.reason,
    errorMessage: failure.message,
    transaction: '',
    network,
  };
  if (failure.cap !== undefined) response.extra = { cap: failure.cap };
  return response;
}
