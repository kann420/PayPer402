import type { Network } from '@x402/core/types';

/** CAIP-2 style network id for the PayPal sandbox. */
export const PAYPAL_SANDBOX_NETWORK = 'paypal:sandbox' satisfies Network;

/** x402 scheme this binding implements. */
export const SCHEME = 'batch-settlement';

/** ISO 4217 asset code; amounts are in cents (atomic units). */
export const ASSET = 'USD';
