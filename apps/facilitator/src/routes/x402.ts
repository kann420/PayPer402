import { Router } from 'express';
import type { x402Facilitator } from '@x402/core/facilitator';
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types';
import { ErrorCode, PAYPAL_SANDBOX_NETWORK, SCHEME } from '@payper402/scheme-paypal';
import { z } from 'zod';
import { authOf } from '../auth';
import { handler, parse } from '../http';

/**
 * The outer shape `HTTPFacilitatorClient` sends. Inner objects pass through untouched: the scheme
 * validates them and answers payment-level failures with 200 and a binding error code.
 */
const bodySchema = z.object({
  x402Version: z.number(),
  paymentPayload: z.looseObject({}),
  paymentRequirements: z.looseObject({}),
});

const MISMATCH = ErrorCode.requirementsMismatch;
const X402_VERSION = 2;

interface Rejection {
  code: string;
  message: string;
}

/**
 * Checks done before the scheme runs: seller ownership (binding spec, Trust model) and that the
 * request targets the one registered kind, so the SDK never throws for an unknown kind.
 */
function precheck(sellerId: string, requirements: PaymentRequirements, payload: PaymentPayload, settle: boolean): Rejection | undefined {
  if (requirements.payTo !== sellerId) {
    return { code: MISMATCH, message: 'paymentRequirements.payTo is not the authenticated seller' };
  }
  if (settle) {
    const inner = payload.payload as { commitment?: { payTo?: unknown } } | undefined;
    const payTo = inner?.commitment?.payTo;
    if (payTo !== undefined && payTo !== sellerId) {
      return { code: MISMATCH, message: 'commitment.payTo is not the authenticated seller' };
    }
  }
  if (requirements.scheme !== SCHEME || requirements.network !== PAYPAL_SANDBOX_NETWORK) {
    return { code: MISMATCH, message: `Only ${SCHEME} on ${PAYPAL_SANDBOX_NETWORK} is supported` };
  }
  if (payload.x402Version !== X402_VERSION) {
    return { code: ErrorCode.payload, message: `paymentPayload.x402Version must be ${X402_VERSION}` };
  }
  return undefined;
}

function responseNetwork(requirements: PaymentRequirements): Network {
  return typeof requirements.network === 'string' && requirements.network.startsWith('paypal:')
    ? requirements.network
    : PAYPAL_SANDBOX_NETWORK;
}

/** x402 facilitator endpoints, behind a seller key (design spec §7.1). */
export function x402Routes(facilitator: x402Facilitator): Router {
  const router = Router();

  router.post(
    '/verify',
    handler(async (req, res) => {
      const body = parse(bodySchema, req.body);
      const payload = body.paymentPayload as unknown as PaymentPayload;
      const requirements = body.paymentRequirements as unknown as PaymentRequirements;
      const rejection = precheck(authOf(res).ownerId, requirements, payload, false);
      if (rejection) {
        const response: VerifyResponse = { isValid: false, invalidReason: rejection.code, invalidMessage: rejection.message };
        res.json(response);
        return;
      }
      res.json(await facilitator.verify(payload, requirements));
    }),
  );

  router.post(
    '/settle',
    handler(async (req, res) => {
      const body = parse(bodySchema, req.body);
      const payload = body.paymentPayload as unknown as PaymentPayload;
      const requirements = body.paymentRequirements as unknown as PaymentRequirements;
      const rejection = precheck(authOf(res).ownerId, requirements, payload, true);
      if (rejection) {
        const response: SettleResponse = {
          success: false,
          errorReason: rejection.code,
          errorMessage: rejection.message,
          transaction: '',
          network: responseNetwork(requirements),
        };
        res.json(response);
        return;
      }
      res.json(await facilitator.settle(payload, requirements));
    }),
  );

  router.get('/supported', (_req, res) => {
    res.json(facilitator.getSupported());
  });

  return router;
}
