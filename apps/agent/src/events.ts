import { ErrorCode } from '@payper402/scheme-paypal';
import type { BlockedCheck, DecidedCheck, DecisionLayerReport } from './spend-check';

export type { BlockedCheck, DecidedCheck, DecisionLayerReport, RuleMode, SpendCheckSummary, SpendRule } from './spend-check';

/** Why a payment was refused (design spec §4.5). */
export type RefusalCode =
  | 'over_per_call_limit'
  | 'over_budget'
  | 'price_changed'
  | 'payee_mismatch'
  | 'cap_exceeded'
  | 'wallet_revoked'
  | 'wallet_not_linked'
  | 'agent_disabled'
  | 'unknown_agent'
  | 'payment_rejected'
  | 'duplicate_call'
  | 'not_needed'
  | 'already_covered';

export type RunStatus = 'completed' | 'incomplete' | 'refused' | 'error';

export interface SpendReportLine {
  serviceId: string;
  serviceName: string;
  calls: number;
  unitPriceCents: number;
  totalCents: number;
}

/** The spend report (design spec §4.7). Every number comes from code, none from the model. */
export interface SpendReport {
  sellerName: string;
  budgetCents: number;
  spentCents: number;
  uncertainCents: number;
  remainingCents: number;
  lines: SpendReportLine[];
  notUsed: { serviceId: string; serviceName: string; priceCents: number }[];
  refusals: { serviceId: string; code: RefusalCode }[];
  commitmentIds: string[];
  explanation: string;
  /** Present only when the decision layer was enabled (decision-layer spec §6). */
  decisionLayer?: DecisionLayerReport;
}

/** The Phase 4 event contract (design spec §4.6). `at` is unix milliseconds. Plain JSON. */
export type AgentEvent =
  | { type: 'started'; at: number; sellerName: string; budgetCents: number; maxPerCallCents: number; task?: string }
  | { type: 'thinking'; at: number; note: string }
  | {
      type: 'discovered_price';
      at: number;
      callId: string;
      serviceId: string;
      serviceName: string;
      priceCents: number;
      catalogPriceCents: number;
    }
  | {
      type: 'decided';
      at: number;
      callId: string;
      serviceId: string;
      serviceName: string;
      priceCents: number;
      note: string;
      remainingCents: number;
      /** Status passed, flagged or unavailable; absent when the decision layer is off. */
      check?: DecidedCheck;
    }
  | {
      type: 'paid';
      at: number;
      callId: string;
      serviceId: string;
      serviceName: string;
      amountCents: number;
      commitmentId: string | null;
      httpStatus: number;
      spentCents: number;
      remainingCents: number;
    }
  | {
      type: 'refused';
      at: number;
      callId: string;
      serviceId: string;
      serviceName: string;
      code: RefusalCode;
      by: 'agent' | 'facilitator';
      note: string;
      detail?: string;
      /** Status blocked, for the two Jev codes and their repeats. */
      check?: BlockedCheck;
    }
  | {
      type: 'failed';
      at: number;
      callId?: string;
      serviceId?: string;
      serviceName?: string;
      note: string;
      charged: 'no' | 'unknown';
    }
  | { type: 'result'; at: number; status: RunStatus; answer: string; report: SpendReport };

/** The UI copy of each refusal, used verbatim by Phase 4. */
export const REFUSAL_NOTES: Record<RefusalCode, string> = {
  over_per_call_limit: 'Over the per-call limit',
  over_budget: 'Over the run budget',
  price_changed: 'The price asked is higher than the catalog price',
  payee_mismatch: 'The payment recipient does not match the catalog',
  cap_exceeded: "Over the operator's spending limit",
  wallet_revoked: "Payment required: the operator's PayPal link was stopped.",
  wallet_not_linked: 'The operator has not linked a PayPal account',
  agent_disabled: 'This agent is paused',
  unknown_agent: "This agent's key is not registered",
  payment_rejected: 'The payment was rejected',
  duplicate_call: 'This exact call was already made in this run',
  not_needed: 'The decision layer judged this call not needed for the task',
  already_covered: 'The decision layer judged this information already obtained',
};

/** Refusals after which every later call is answered locally with `payments_blocked`. */
export const BLOCKING_REFUSALS: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  'wallet_revoked',
  'wallet_not_linked',
  'agent_disabled',
  'unknown_agent',
]);

/** Failure notes used by the payer. */
export const FAILURE_NOTES = {
  unreadable402: 'The service sent an unreadable 402',
  invalidAmount: 'The service asked for an invalid amount',
  unknownOutcome: 'The payment outcome is unknown',
  signingFailed: 'Signing the payment failed',
  payloadMismatch: 'The signed payment does not match the checked price',
  overReported: 'The seller reported a higher amount than the signed maximum',
  unreachable: 'The service could not be reached',
  notCompleted: 'The payment was not completed',
} as const;

const BINDING_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

/** True when `code` is a member of the binding's `ErrorCode` (`invalid_batch_settlement_paypal_*`). */
export function isBindingCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && BINDING_CODES.has(code);
}

const BY_BINDING_CODE: Partial<Record<ErrorCode, RefusalCode>> = {
  [ErrorCode.capExceeded]: 'cap_exceeded',
  [ErrorCode.walletRevoked]: 'wallet_revoked',
  [ErrorCode.walletNotLinked]: 'wallet_not_linked',
  [ErrorCode.agentDisabled]: 'agent_disabled',
  [ErrorCode.unknownAgent]: 'unknown_agent',
};

/** Maps a binding code to its refusal; any other binding code is `payment_rejected` with the raw code as `detail`. */
export function refusalForBindingCode(code: ErrorCode): { code: RefusalCode; detail?: string } {
  const mapped = BY_BINDING_CODE[code];
  return mapped === undefined ? { code: 'payment_rejected', detail: code } : { code: mapped };
}
