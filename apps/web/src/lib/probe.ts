/**
 * "Test it" (design spec §10.11): one unpaid request to a seller endpoint with fixed sample
 * params, answered with the status line, three headers and the decoded `PAYMENT-REQUIRED`.
 */
import type { Catalog } from '@payper402/agent';

export interface ProbeResult {
  status: number;
  statusText: string;
  headers: { 'payment-required': string | null; 'content-type': string | null; 'cache-control': string | null };
  decoded: unknown;
  /** `<METHOD> <path with query>`, as sent. */
  request: string;
  ms: number;
}

/** The fixed sample request of each demo service. The summarize body never names a real article. */
export function sampleRequest(serviceId: string, sellerUrl: string): { query?: Record<string, string>; body?: Record<string, string> } | undefined {
  switch (serviceId) {
    case 'quote':
      return { query: { symbol: 'KC' } };
    case 'summarize':
      return { body: { url: `${sellerUrl}/news/x` } };
    case 'translate':
      return { body: { text: 'Hello', targetLanguage: 'Vietnamese' } };
    case 'premium_news':
      return { query: { topic: 'coffee' } };
    default:
      return undefined;
  }
}

/** Base64 JSON of the `PAYMENT-REQUIRED` header, or undefined when it does not decode. */
export function decodePaymentRequired(header: string | null): unknown {
  if (header === null || header === '') return undefined;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export async function probe(options: { catalog: Catalog; serviceId: string; sellerUrl: string; fetch?: typeof fetch; now?: () => number }): Promise<ProbeResult | undefined> {
  const service = options.catalog.services.find((s) => s.id === options.serviceId);
  const sample = sampleRequest(options.serviceId, options.sellerUrl);
  if (service === undefined || sample === undefined) return undefined;
  const url = new URL(service.path, options.sellerUrl);
  for (const [k, v] of Object.entries(sample.query ?? {})) url.searchParams.set(k, v);
  const now = options.now ?? Date.now;
  const started = now();
  const res = await (options.fetch ?? fetch)(url, {
    method: service.method,
    headers: sample.body === undefined ? {} : { 'content-type': 'application/json' },
    ...(sample.body === undefined ? {} : { body: JSON.stringify(sample.body) }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'manual',
  });
  await res.body?.cancel().catch(() => undefined);
  const header = res.headers.get('payment-required');
  return {
    status: res.status,
    statusText: res.statusText,
    headers: { 'payment-required': header, 'content-type': res.headers.get('content-type'), 'cache-control': res.headers.get('cache-control') },
    decoded: decodePaymentRequired(header),
    request: `${service.method} ${url.pathname}${url.search}`,
    ms: now() - started,
  };
}
