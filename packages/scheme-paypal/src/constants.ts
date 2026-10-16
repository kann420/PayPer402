import type { Network } from '@x402/core/types';

/** CAIP-2 style network id for the PayPal sandbox. */
export const PAYPAL_SANDBOX_NETWORK = 'paypal:sandbox' satisfies Network;

/** Wildcard covering every PayPal network, for client and resource-server registration. */
export const PAYPAL_NETWORK_FAMILY = 'paypal:*' satisfies Network;

/** x402 scheme this binding implements. */
export const SCHEME = 'batch-settlement';

/** ISO 4217 asset code; amounts are in cents (atomic units). */
export const ASSET = 'USD';

/** Decimal places of the asset: amounts are cents. */
export const ASSET_DECIMALS = 2;

/** Binding version advertised in `extra.version`. */
export const BINDING_VERSION = '1.0.0';

/** Commitment format version (`commitment.v`). */
export const COMMITMENT_VERSION = 1;

/** Commitment lifetime the reference client uses. */
export const CLIENT_TTL_SECONDS = 120;

/** Longest commitment lifetime the binding allows. */
export const MAX_TIMEOUT_SECONDS = 300;

/** How far in the future `iat` may be. */
export const CLOCK_SKEW_SECONDS = 30;

/** Extra time after `exp` during which a verified commitment may still be settled. */
export const SETTLE_GRACE_SECONDS = 60;

/** Domain prefix of every signed commitment message. */
export const SIGNATURE_DOMAIN = 'payper402/commitment/v1\n';

/** Returns true when `network` belongs to the PayPal family (`paypal:<anything>`). */
export function isPayPalNetwork(network: string): network is Network {
  return /^paypal:[-_a-zA-Z0-9]{1,32}$/.test(network);
}
