import { resolveApiBase } from './config';
import { PayPalApiError, PayPalNetworkError } from './errors';
import { centsToUsdString, usdStringToCents } from './money';
import type {
  CaptureResult,
  ChargeResult,
  ChargeVaultedWalletInput,
  CreateSetupTokenInput,
  CreatedSetupToken,
  PayPalClientOptions,
  PaymentTokenResult,
  SetupTokenResult,
  VerifyWebhookSignatureInput,
} from './types';

const DEFAULT_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
const ORDER_PATH = /^\/v2\/checkout\/orders\/([^/?]+)/;
const SETUP_TOKEN_DISPLAY = '/v3/vault/setup-tokens/*';
const PAYMENT_TOKEN_DISPLAY = '/v3/vault/payment-tokens/*';

type Json = Record<string, unknown>;

interface RequestOptions {
  body?: Json;
  /**
   * A secret id in the path (payment or setup token). Errors show the path with it replaced by
   * `*`, and it is scrubbed from PayPal's message, so it never reaches logs or audit records.
   */
  redact?: string;
  requestId?: string;
  orders?: boolean;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const systemNow = () => Math.floor(Date.now() / 1000);

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Typed PayPal REST client for the sandbox. Covers OAuth, Vault v3, Orders v2 and webhook
 * signature verification. It never logs or throws the client secret or the access token.
 */
export class PayPalClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: CachedToken | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(options: PayPalClientOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new TypeError('PayPalClient needs a client id and a client secret');
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.apiBase = resolveApiBase(options.apiBase);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? systemNow;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Returns a cached access token, or fetches one. Concurrent callers share one request. */
  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchAccessToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  async createSetupToken(input: CreateSetupTokenInput): Promise<CreatedSetupToken> {
    const json = await this.call('POST', '/v3/vault/setup-tokens', {
      requestId: input.requestId,
      body: {
        payment_source: {
          paypal: {
            description: input.description,
            usage_type: 'MERCHANT',
            usage_pattern: 'UNSCHEDULED_POSTPAID',
            customer_type: 'CONSUMER',
            experience_context: {
              brand_name: input.brandName,
              shipping_preference: 'NO_SHIPPING',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      },
    });
    const token = this.mapSetupToken(json, 'POST', '/v3/vault/setup-tokens');
    const approve = asArray(json['links'])
      .map(asObject)
      .find((link) => link?.['rel'] === 'approve');
    const approveUrl = asString(approve?.['href']);
    if (!approveUrl) {
      throw new PayPalNetworkError('POST', '/v3/vault/setup-tokens', 'setup token has no approve link');
    }
    return { ...token, approveUrl };
  }

  async getSetupToken(id: string): Promise<SetupTokenResult> {
    const path = `/v3/vault/setup-tokens/${encodeURIComponent(id)}`;
    return this.mapSetupToken(await this.call('GET', path, { redact: id }), 'GET', SETUP_TOKEN_DISPLAY);
  }

  async createPaymentToken(setupTokenId: string, requestId: string): Promise<PaymentTokenResult> {
    const path = '/v3/vault/payment-tokens';
    const json = await this.call('POST', path, {
      requestId,
      body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
    });
    return this.mapPaymentToken(json, 'POST', path);
  }

  async getPaymentToken(id: string): Promise<PaymentTokenResult> {
    const path = `/v3/vault/payment-tokens/${encodeURIComponent(id)}`;
    return this.mapPaymentToken(await this.call('GET', path, { redact: id }), 'GET', PAYMENT_TOKEN_DISPLAY);
  }

  async deletePaymentToken(id: string): Promise<void> {
    await this.call('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(id)}`, { redact: id });
  }

  /**
   * Charges a vaulted PayPal wallet with one Orders v2 order (`intent: CAPTURE`). If the order
   * comes back `CREATED` or `APPROVED`, it is captured with request id `<requestId>:capture`.
   */
  async chargeVaultedWallet(input: ChargeVaultedWalletInput): Promise<ChargeResult> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1) {
      throw new RangeError('amountCents must be a positive safe integer');
    }
    const path = '/v2/checkout/orders';
    const order = await this.call('POST', path, {
      orders: true,
      requestId: input.requestId,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: { currency_code: 'USD', value: centsToUsdString(input.amountCents) },
            invoice_id: input.invoiceId,
            custom_id: input.invoiceId,
            description: input.description.slice(0, 127),
          },
        ],
        payment_source: { paypal: { vault_id: input.vaultId } },
      },
    });
    const created = this.mapOrder(order, 'POST', path);
    if (created.orderStatus !== 'CREATED' && created.orderStatus !== 'APPROVED') return created;
    const capturePath = `/v2/checkout/orders/${encodeURIComponent(created.orderId)}/capture`;
    const captured = await this.call('POST', capturePath, {
      orders: true,
      requestId: `${input.requestId}:capture`,
      body: {},
    });
    return this.mapOrder(captured, 'POST', capturePath);
  }

  async getOrder(orderId: string): Promise<ChargeResult> {
    const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
    return this.mapOrder(await this.call('GET', path, { orders: true }), 'GET', path);
  }

  /**
   * Verifies a webhook with PayPal. The raw body is spliced verbatim into the request, because
   * PayPal requires the event exactly as received. Missing headers or a body that is not JSON
   * return false without a network call; a 4xx answer from PayPal also returns false.
   */
  async verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> {
    const header = (name: string): string | undefined => {
      for (const [key, value] of Object.entries(input.headers)) {
        if (key.toLowerCase() === name && typeof value === 'string' && value.length > 0) return value;
      }
      return undefined;
    };
    const fields = {
      auth_algo: header('paypal-auth-algo'),
      cert_url: header('paypal-cert-url'),
      transmission_id: header('paypal-transmission-id'),
      transmission_sig: header('paypal-transmission-sig'),
      transmission_time: header('paypal-transmission-time'),
    };
    if (Object.values(fields).some((value) => value === undefined) || !input.webhookId) return false;
    try {
      const event: unknown = JSON.parse(input.rawBody);
      if (!asObject(event)) return false;
    } catch {
      return false;
    }
    const head = JSON.stringify({ ...fields, webhook_id: input.webhookId });
    const body = `${head.slice(0, -1)},"webhook_event":${input.rawBody}}`;
    try {
      const json = await this.call('POST', '/v1/notifications/verify-webhook-signature', { rawJson: body });
      return json['verification_status'] === 'SUCCESS';
    } catch (err) {
      if (err instanceof PayPalApiError && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429) {
        return false;
      }
      throw err;
    }
  }

  // --- internals -----------------------------------------------------------

  private async fetchAccessToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const json = await this.send('POST', '/v1/oauth2/token', {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }, 'grant_type=client_credentials');
    const value = asString(json['access_token']);
    const expiresIn = json['expires_in'];
    if (!value || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      throw new PayPalNetworkError('POST', '/v1/oauth2/token', 'token response is missing fields');
    }
    this.token = { value, expiresAt: this.now() + expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS };
    return value;
  }

  /** An authenticated call. On a 401 the token is refreshed once and the call retried once. */
  private async call(
    method: string,
    path: string,
    options: RequestOptions & { rawJson?: string } = {},
  ): Promise<Json> {
    const attempt = async (): Promise<Json> => {
      const token = await this.getAccessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      let body: string | undefined;
      if (options.rawJson !== undefined) {
        body = options.rawJson;
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.requestId !== undefined) headers['PayPal-Request-Id'] = options.requestId;
      if (options.orders) headers['Prefer'] = 'return=representation';
      return this.send(method, path, headers, body, options.redact);
    };
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof PayPalApiError && err.httpStatus === 401) {
        this.token = undefined;
        return attempt();
      }
      throw err;
    }
  }

  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
    redact?: string,
  ): Promise<Json> {
    const scrub = (text: string) =>
      redact ? text.split(encodeURIComponent(redact)).join('*').split(redact).join('*') : text;
    const display = scrub(path);
    let response: Response;
    let text: string;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) init.body = body;
      response = await this.fetchImpl(`${this.apiBase}${path}`, init);
      text = await response.text();
    } catch (err) {
      const reason = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timed out' : 'network error';
      throw new PayPalNetworkError(method, display, reason, { cause: err });
    }
    let json: Json | undefined;
    if (text.length === 0) {
      json = {};
    } else {
      try {
        json = asObject(JSON.parse(text));
      } catch {
        json = undefined;
      }
    }
    if (response.ok) {
      if (!json) throw new PayPalNetworkError(method, display, `unparseable response (HTTP ${response.status})`);
      return json;
    }
    const data = json ?? {};
    const issues = asArray(data['details'])
      .map((detail) => asString(asObject(detail)?.['issue']))
      .filter((issue): issue is string => issue !== undefined);
    const debugId = asString(data['debug_id']) ?? response.headers.get('paypal-debug-id') ?? undefined;
    const orderId = ORDER_PATH.exec(path)?.[1];
    throw new PayPalApiError({
      httpStatus: response.status,
      name: asString(data['name']) ?? asString(data['error']) ?? `HTTP_${response.status}`,
      message: scrub(asString(data['message']) ?? asString(data['error_description']) ?? ''),
      issues,
      method,
      path: display,
      ...(debugId === undefined ? {} : { debugId }),
      ...(orderId === undefined ? {} : { orderId: decodeURIComponent(orderId) }),
    });
  }

  private mapSetupToken(json: Json, method: string, path: string): SetupTokenResult {
    const id = asString(json['id']);
    const status = asString(json['status']);
    if (!id || !status) throw new PayPalNetworkError(method, path, 'setup token response is missing fields');
    return { id, status };
  }

  private mapPaymentToken(json: Json, method: string, path: string): PaymentTokenResult {
    const id = asString(json['id']);
    if (!id) throw new PayPalNetworkError(method, path, 'payment token response has no id');
    const customerId = asString(asObject(json['customer'])?.['id']);
    const payerEmail = asString(asObject(asObject(json['payment_source'])?.['paypal'])?.['email_address']);
    return {
      id,
      ...(customerId === undefined ? {} : { customerId }),
      ...(payerEmail === undefined ? {} : { payerEmail }),
    };
  }

  private mapOrder(json: Json, method: string, path: string): ChargeResult {
    const orderId = asString(json['id']);
    const orderStatus = asString(json['status']);
    if (!orderId || !orderStatus) throw new PayPalNetworkError(method, path, 'order response is missing fields');
    const unit = asObject(asArray(json['purchase_units'])[0]);
    const raw = asObject(asArray(asObject(unit?.['payments'])?.['captures'])[0]);
    if (!raw) return { orderId, orderStatus };
    try {
      return { orderId, orderStatus, capture: mapCapture(raw) };
    } catch (err) {
      throw new PayPalNetworkError(method, path, 'capture in order response is malformed', { cause: err });
    }
  }
}

/** Maps an Orders v2 capture object (also the `resource` of `PAYMENT.CAPTURE.*` webhooks). */
export function mapCapture(raw: Record<string, unknown>): CaptureResult {
  const id = asString(raw['id']);
  const status = asString(raw['status']);
  const value = asString(asObject(raw['amount'])?.['value']);
  if (!id || !status || value === undefined) throw new TypeError('capture is missing id, status or amount');
  const capture: CaptureResult = { id, status, amountCents: usdStringToCents(value) };
  const reason = asString(asObject(raw['status_details'])?.['reason']);
  if (reason !== undefined) capture.statusReason = reason;
  const breakdown = asObject(raw['seller_receivable_breakdown']);
  const fee = asString(asObject(breakdown?.['paypal_fee'])?.['value']);
  const net = asString(asObject(breakdown?.['net_amount'])?.['value']);
  if (fee !== undefined) capture.feeCents = usdStringToCents(fee);
  if (net !== undefined) capture.netCents = usdStringToCents(net);
  return capture;
}
