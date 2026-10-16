/** Shared helpers for the package's tests. Not exported from the package entry point. */
import type { KeyObject } from 'node:crypto';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { buildCommitment, signCommitment, type PayPalBatchPayload } from './commitment';
import { ASSET, BINDING_VERSION, PAYPAL_SANDBOX_NETWORK, SCHEME } from './constants';
import { PayPalBatchFacilitatorScheme } from './facilitator';
import { generateAgentKey, type AgentKey } from './keys';
import { InMemoryAgentRegistry, InMemoryCommitmentLedger } from './memory';
import type { Caps } from './stores';

/** 2025-10-15T03:46:40Z, a fixed clock for deterministic tests. */
export const T0 = 1_760_500_000;

export const OPERATOR_ID = 'op_test';
export const AGENT_ID = 'agent_test';
export const PAY_TO = 'seller_test';

export const DEFAULT_CAPS: Caps = { perCall: 25, daily: 100, unsettled: 50 };

export function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: PAYPAL_SANDBOX_NETWORK,
    asset: ASSET,
    amount: '5',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { version: BINDING_VERSION },
    ...overrides,
  };
}

export interface CommitmentOptions {
  iat?: number;
  lifetime?: number;
  id?: string;
}

/** Builds and signs a commitment matching `requirements`. */
export function signedPayload(
  privateKey: KeyObject,
  kid: string,
  requirements: PaymentRequirements,
  options: CommitmentOptions = {},
): PayPalBatchPayload {
  const iat = options.iat ?? T0;
  const commitment = buildCommitment({
    kid,
    network: requirements.network,
    asset: requirements.asset,
    payTo: requirements.payTo,
    maxAmount: requirements.amount,
    iat,
    exp: iat + (options.lifetime ?? 120),
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  return { commitment, signature: signCommitment(commitment, privateKey) };
}

/** Wraps a scheme payload in an x402 v2 PaymentPayload whose `accepted` is `requirements`. */
export function paymentPayload(
  payload: PayPalBatchPayload | Record<string, unknown>,
  requirements: PaymentRequirements,
): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: 'https://seller.test/api/quote' },
    accepted: requirements,
    payload: { ...payload },
  };
}

/** Returns a copy of the payload with commitment fields replaced and the signature kept. */
export function tamper(payload: PayPalBatchPayload, changes: Record<string, unknown>): Record<string, unknown> {
  return { commitment: { ...payload.commitment, ...changes }, signature: payload.signature };
}

export interface Harness {
  key: AgentKey;
  registry: InMemoryAgentRegistry;
  ledger: InMemoryCommitmentLedger;
  facilitator: PayPalBatchFacilitatorScheme;
  clock: { now: number };
  /** Signs a commitment for `requirements` at the current clock. */
  pay(requirements: PaymentRequirements, options?: CommitmentOptions): PaymentPayload;
}

export function createHarness(caps: Caps = DEFAULT_CAPS): Harness {
  const key = generateAgentKey();
  const registry = new InMemoryAgentRegistry()
    .addOperator({ operatorId: OPERATOR_ID, walletStatus: 'active', caps })
    .addAgent({ agentId: AGENT_ID, kid: key.kid, publicKeyX: key.publicKeyX, operatorId: OPERATOR_ID, status: 'active' });
  const ledger = new InMemoryCommitmentLedger();
  const clock = { now: T0 };
  const facilitator = new PayPalBatchFacilitatorScheme({ agents: registry, ledger, now: () => clock.now });
  return {
    key,
    registry,
    ledger,
    facilitator,
    clock,
    pay: (requirements, options = {}) =>
      paymentPayload(
        signedPayload(key.privateKey, key.kid, requirements, { iat: clock.now, ...options }),
        requirements,
      ),
  };
}

