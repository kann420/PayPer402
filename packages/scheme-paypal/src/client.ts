import type { KeyObject } from 'node:crypto';
import type {
  DefaultAsset,
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types';
import { buildCommitment, signCommitment, type PayPalBatchPayload } from './commitment';
import {
  ASSET,
  ASSET_DECIMALS,
  BINDING_VERSION,
  CLIENT_TTL_SECONDS,
  MAX_TIMEOUT_SECONDS,
  SCHEME,
  isPayPalNetwork,
} from './constants';
import { agentKeyFromPrivateKey } from './keys';
import { tryParseCentsString } from './money';

export interface PayPalBatchClientSchemeOptions {
  /** The agent's Ed25519 private key. */
  privateKey: KeyObject;
  /** Clock in unix seconds. Defaults to the system clock. */
  now?: () => number;
  /** Commitment lifetime in seconds, 1 to 300. Defaults to `CLIENT_TTL_SECONDS` (120). */
  ttlSeconds?: number;
}

const USD_DEFAULT_ASSET: DefaultAsset = { asset: ASSET, decimals: ASSET_DECIMALS, symbol: ASSET };
const SUPPORTED_MAJOR = BINDING_VERSION.split('.')[0];

const systemNow = () => Math.floor(Date.now() / 1000);

/** Client (agent) side of the binding: signs one commitment per paid request. */
export class PayPalBatchClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  /** Key id of the agent key, as registered with the facilitator. */
  readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly now: () => number;
  private readonly ttlSeconds: number;

  constructor(options: PayPalBatchClientSchemeOptions) {
    const ttl = options.ttlSeconds ?? CLIENT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TIMEOUT_SECONDS) {
      throw new RangeError(`ttlSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
    }
    this.kid = agentKeyFromPrivateKey(options.privateKey).kid;
    this.privateKey = options.privateKey;
    this.now = options.now ?? systemNow;
    this.ttlSeconds = ttl;
  }

  /** Recognises USD on PayPal networks, so the SDK's default spend controls accept it. */
  findDefaultAsset = (asset: string, network: Network): DefaultAsset | undefined =>
    asset === ASSET && isPayPalNetwork(network) ? { ...USD_DEFAULT_ASSET } : undefined;

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult> {
    if (requirements.scheme !== SCHEME) {
      throw new Error(`Unsupported scheme: ${requirements.scheme}`);
    }
    if (!isPayPalNetwork(requirements.network)) {
      throw new Error(`Unsupported network: ${requirements.network}`);
    }
    if (requirements.asset !== ASSET) {
      throw new Error(`Unsupported asset: ${requirements.asset}`);
    }
    if (tryParseCentsString(requirements.amount) === undefined) {
      throw new Error(`Invalid amount: ${JSON.stringify(requirements.amount)}`);
    }
    if (typeof requirements.payTo !== 'string' || requirements.payTo.length === 0) {
      throw new Error('Missing payTo');
    }
    const version = requirements.extra?.['version'];
    if (typeof version === 'string' && version.split('.')[0] !== SUPPORTED_MAJOR) {
      throw new Error(`Unsupported binding version: ${version}`);
    }

    const serverMax =
      Number.isSafeInteger(requirements.maxTimeoutSeconds) && requirements.maxTimeoutSeconds > 0
        ? requirements.maxTimeoutSeconds
        : MAX_TIMEOUT_SECONDS;
    const lifetime = Math.min(this.ttlSeconds, serverMax, MAX_TIMEOUT_SECONDS);
    const iat = this.now();

    const commitment = buildCommitment({
      kid: this.kid,
      network: requirements.network,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxAmount: requirements.amount,
      iat,
      exp: iat + lifetime,
    });
    const payload: PayPalBatchPayload = { commitment, signature: signCommitment(commitment, this.privateKey) };
    return { x402Version, payload: { ...payload } };
  }
}
