/** `invalidReason` / `errorReason` codes defined by the binding spec. */
export const ErrorCode = {
  payload: 'invalid_batch_settlement_paypal_payload',
  requirementsMismatch: 'invalid_batch_settlement_paypal_requirements_mismatch',
  expired: 'invalid_batch_settlement_paypal_expired',
  unknownAgent: 'invalid_batch_settlement_paypal_unknown_agent',
  agentDisabled: 'invalid_batch_settlement_paypal_agent_disabled',
  signature: 'invalid_batch_settlement_paypal_signature',
  walletNotLinked: 'invalid_batch_settlement_paypal_wallet_not_linked',
  walletRevoked: 'invalid_batch_settlement_paypal_wallet_revoked',
  replay: 'invalid_batch_settlement_paypal_replay',
  capExceeded: 'invalid_batch_settlement_paypal_cap_exceeded',
  amountExceedsCommitment: 'invalid_batch_settlement_paypal_amount_exceeds_commitment',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
