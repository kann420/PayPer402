import { PayPalApiError, type CaptureDetails } from '@payper402/paypal-client';
import type { SettlementRow } from '../db/rows';
import { HttpError } from '../http';
import { errorMessage } from '../logger';
import type { ServiceContext } from './context';

export type VerificationCheckName = 'capture_found' | 'completed' | 'amount' | 'currency' | 'invoice' | 'order';

export interface VerificationCheck {
  name: VerificationCheckName;
  ok: boolean;
  /** What the PayPer402 ledger says. */
  expected: string;
  /** What PayPal says, or null when PayPal has no value. */
  actual: string | null;
}

export interface SettlementVerification {
  settlementId: string;
  checkedAt: number;
  /** True only when every check passed. */
  verified: boolean;
  paypal: {
    captureId: string;
    status: string;
    amount: number;
    currency: string;
    invoiceId: string | null;
    orderId: string | null;
    createTime: string | null;
    updateTime: string | null;
  } | null;
  checks: VerificationCheck[];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Checks a captured settlement against PayPal itself: the capture is read with
 * `GET /v2/payments/captures/{id}` and compared with the ledger (status, amount, currency, the
 * invoice id PayPer402 sent, and the order). Nothing is written. A capture PayPal does not know is
 * a failed verification, not an error; PayPal being unreachable is a 502.
 */
export async function verifySettlement(ctx: ServiceContext, row: SettlementRow): Promise<SettlementVerification> {
  if (row.paypal_capture_id === null) {
    throw new HttpError(409, 'not_captured', 'This charge has no PayPal capture to verify yet.');
  }
  const checkedAt = ctx.clock();
  let capture: CaptureDetails | undefined;
  try {
    capture = await ctx.paypal.getCapture(row.paypal_capture_id);
  } catch (err) {
    if (!(err instanceof PayPalApiError && err.httpStatus === 404)) {
      ctx.logger.warn('Settlement verification failed', { settlementId: row.id, error: errorMessage(err) });
      throw new HttpError(502, 'paypal_unavailable', 'PayPal could not be reached. Try again in a moment.');
    }
  }
  if (capture === undefined) {
    return {
      settlementId: row.id,
      checkedAt,
      verified: false,
      paypal: null,
      checks: [{ name: 'capture_found', ok: false, expected: row.paypal_capture_id, actual: null }],
    };
  }
  const checks: VerificationCheck[] = [
    { name: 'capture_found', ok: capture.id === row.paypal_capture_id, expected: row.paypal_capture_id, actual: capture.id },
    { name: 'completed', ok: capture.status === 'COMPLETED', expected: 'COMPLETED', actual: capture.status },
    { name: 'amount', ok: capture.amountCents === row.amount, expected: usd(row.amount), actual: usd(capture.amountCents) },
    { name: 'currency', ok: capture.currency === 'USD', expected: 'USD', actual: capture.currency },
    { name: 'invoice', ok: capture.invoiceId === row.id, expected: row.id, actual: capture.invoiceId ?? null },
  ];
  if (row.paypal_order_id !== null) {
    checks.push({ name: 'order', ok: capture.orderId === row.paypal_order_id, expected: row.paypal_order_id, actual: capture.orderId ?? null });
  }
  return {
    settlementId: row.id,
    checkedAt,
    verified: checks.every((c) => c.ok),
    paypal: {
      captureId: capture.id,
      status: capture.status,
      amount: capture.amountCents,
      currency: capture.currency,
      invoiceId: capture.invoiceId ?? null,
      orderId: capture.orderId ?? null,
      createTime: capture.createTime ?? null,
      updateTime: capture.updateTime ?? null,
    },
    checks,
  };
}
