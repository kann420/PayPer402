import { PayPalClient } from '@payper402/paypal-client';
import type { Config } from './config';

/** The subset of `PayPalClient` the facilitator uses. Tests substitute a fake. */
export type PayPalGateway = Pick<
  PayPalClient,
  | 'createSetupToken'
  | 'getSetupToken'
  | 'createPaymentToken'
  | 'getPaymentToken'
  | 'deletePaymentToken'
  | 'chargeVaultedWallet'
  | 'getOrder'
  | 'getCapture'
  | 'verifyWebhookSignature'
>;

/** Builds the real gateway from configuration (sandbox guard enforced by the client). */
export function createPayPalGateway(config: Config): PayPalGateway {
  return new PayPalClient({
    clientId: config.paypalClientId,
    clientSecret: config.paypalClientSecret,
    apiBase: config.paypalApiBase,
  });
}
