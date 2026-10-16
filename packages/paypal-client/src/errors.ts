/** PayPal `details[].issue` codes that mean the payer stopped the agreement or the token is gone. */
export const REVOCATION_ISSUES: ReadonlySet<string> = new Set([
  'AGREEMENT_ALREADY_CANCELLED',
  'TOKEN_ID_NOT_FOUND',
  'TOKEN_NOT_FOUND',
  'BILLING_AGREEMENT_NOT_FOUND',
]);

/** Issue codes that mean the charge was declined but the agreement still stands. */
export const DECLINE_ISSUES: ReadonlySet<string> = new Set([
  'INSTRUMENT_DECLINED',
  'PAYER_CANNOT_PAY',
  'TRANSACTION_REFUSED',
  'PAYER_ACCOUNT_RESTRICTED',
  'PAYMENT_SOURCE_DECLINED_BY_PROCESSOR',
  'PAYER_ACTION_REQUIRED',
]);

/** Issue codes that mean the same order or invoice was already processed. */
export const DUPLICATE_ISSUES: ReadonlySet<string> = new Set(['DUPLICATE_INVOICE_ID', 'ORDER_ALREADY_CAPTURED']);

export type PayPalErrorClass = 'revocation' | 'decline' | 'duplicate' | 'transient' | 'other';

export interface PayPalApiErrorInit {
  httpStatus: number;
  name: string;
  message: string;
  issues: string[];
  debugId?: string;
  method: string;
  path: string;
  orderId?: string;
}

/** A non-2xx answer from the PayPal REST API. Never carries credentials or access tokens. */
export class PayPalApiError extends Error {
  readonly httpStatus: number;
  override readonly name: string;
  readonly issues: string[];
  readonly debugId: string | undefined;
  readonly method: string;
  readonly path: string;
  /** Set when the failing call was on an order path, such as the capture leg. */
  readonly orderId: string | undefined;

  constructor(init: PayPalApiErrorInit) {
    super(`${init.method} ${init.path} -> ${init.httpStatus} ${init.name}${init.message ? `: ${init.message}` : ''}`);
    this.httpStatus = init.httpStatus;
    this.name = init.name;
    this.issues = [...init.issues];
    this.debugId = init.debugId;
    this.method = init.method;
    this.path = init.path;
    this.orderId = init.orderId;
  }
}

/** A network failure, a timeout, or a response that could not be understood. */
export class PayPalNetworkError extends Error {
  override readonly name = 'PayPalNetworkError';
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, message: string, options?: { cause?: unknown }) {
    super(`${method} ${path}: ${message}`, options);
    this.method = method;
    this.path = path;
  }
}

/**
 * Classifies an error thrown by `PayPalClient` (design spec §9.3). Anything that is not a PayPal
 * error is `other`.
 */
export function classifyPayPalError(err: unknown): PayPalErrorClass {
  if (err instanceof PayPalNetworkError) return 'transient';
  if (!(err instanceof PayPalApiError)) return 'other';
  if (err.httpStatus >= 500 || err.httpStatus === 429) return 'transient';
  if (err.issues.some((issue) => REVOCATION_ISSUES.has(issue))) return 'revocation';
  if (err.issues.some((issue) => DECLINE_ISSUES.has(issue))) return 'decline';
  if (err.issues.some((issue) => DUPLICATE_ISSUES.has(issue))) return 'duplicate';
  return 'other';
}
