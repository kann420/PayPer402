export const SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';

const LOCAL_MOCK_BASE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Returns the PayPal API base URL. PayPer402 runs on the sandbox only: any other host is
 * refused, except a localhost URL so tests can point the client at a mock server.
 */
export function resolveApiBase(value?: string): string {
  if (!value) return SANDBOX_API_BASE;
  const base = value.replace(/\/+$/, '');
  if (base === SANDBOX_API_BASE || LOCAL_MOCK_BASE.test(base)) return base;
  throw new Error(`Refusing PayPal API base ${value}: only ${SANDBOX_API_BASE} is allowed.`);
}
