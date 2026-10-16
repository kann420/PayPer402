import type { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network, SupportedResponse } from '@x402/core/types';

/**
 * A `FacilitatorClient` that calls an `x402Facilitator` in the same process. There is no network
 * boundary, so no caller authentication: use it for tests and single-process deployments only.
 */
export function localFacilitatorClient(facilitator: x402Facilitator): FacilitatorClient {
  return {
    verify: (paymentPayload, paymentRequirements) => facilitator.verify(paymentPayload, paymentRequirements),
    settle: (paymentPayload, paymentRequirements) => facilitator.settle(paymentPayload, paymentRequirements),
    getSupported: async (): Promise<SupportedResponse> => {
      const supported = facilitator.getSupported();
      return {
        kinds: supported.kinds.map((kind) => ({
          ...kind,
          // x402Facilitator types this as string; it only ever echoes registered Network ids.
          network: kind.network as Network,
        })),
        extensions: supported.extensions,
        signers: supported.signers,
      };
    },
  };
}
