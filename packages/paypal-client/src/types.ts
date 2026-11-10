export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Goes through `resolveApiBase`: only the sandbox host or a localhost mock is accepted. */
  apiBase?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Clock in unix seconds. */
  now?: () => number;
  /** Per request, default 20 000 ms. */
  timeoutMs?: number;
}

export interface CreateSetupTokenInput {
  returnUrl: string;
  cancelUrl: string;
  description: string;
  brandName: string;
  requestId: string;
}

export interface SetupTokenResult {
  id: string;
  status: string;
}

export interface CreatedSetupToken extends SetupTokenResult {
  approveUrl: string;
}

export interface PaymentTokenResult {
  id: string;
  customerId?: string;
  payerEmail?: string;
}

export interface ChargeVaultedWalletInput {
  vaultId: string;
  amountCents: number;
  requestId: string;
  invoiceId: string;
  description: string;
}

export interface CaptureResult {
  id: string;
  /** COMPLETED | PENDING | DECLINED | FAILED | ... */
  status: string;
  statusReason?: string;
  amountCents: number;
  /** `seller_receivable_breakdown.paypal_fee`. */
  feeCents?: number;
  /** `seller_receivable_breakdown.net_amount`. */
  netCents?: number;
}

/** A capture as PayPal reports it on `GET /v2/payments/captures/{id}`. */
export interface CaptureDetails extends CaptureResult {
  /** `amount.currency_code`. */
  currency: string;
  invoiceId?: string;
  customId?: string;
  /** `supplementary_data.related_ids.order_id`. */
  orderId?: string;
  createTime?: string;
  updateTime?: string;
}

export interface ChargeResult {
  orderId: string;
  orderStatus: string;
  capture?: CaptureResult;
}

export interface VerifyWebhookSignatureInput {
  headers: Record<string, string | undefined>;
  rawBody: string;
  webhookId: string;
}
