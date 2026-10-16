import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from '@x402/core/types';
import { ASSET, ASSET_DECIMALS, BINDING_VERSION, MAX_TIMEOUT_SECONDS, SCHEME, isPayPalNetwork } from './constants';
import { priceToCents } from './money';

/** Resource-server (seller) side of the binding: prices routes in USD cents. */
export class PayPalBatchServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = 'default';
  readonly paymentFlows = {
    default: { supported: ['authorization'] as const, default: 'authorization' as const },
  };

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!isPayPalNetwork(network)) {
      throw new Error(`Unsupported network for ${SCHEME}: ${network}`);
    }
    return { asset: ASSET, amount: String(priceToCents(price)) };
  }

  getAssetDecimals(asset: string): number | undefined {
    return asset === ASSET ? ASSET_DECIMALS : undefined;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    const requested = requirements.maxTimeoutSeconds;
    const maxTimeoutSeconds =
      Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_TIMEOUT_SECONDS) : MAX_TIMEOUT_SECONDS;
    return {
      ...requirements,
      maxTimeoutSeconds,
      extra: { ...requirements.extra, version: BINDING_VERSION },
    };
  }
}
