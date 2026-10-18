/**
 * Test helpers for the web route handlers: the facilitator harness (fake PayPal) behind the real
 * facilitator client, and requests with a cookie jar. Not part of the app.
 */
import { FakeSellerAi } from '@payper402/agent/test-support';
import { startSeller, type RunningSeller } from '@payper402/demo-seller';
import { createHarness, type Harness } from '@payper402/facilitator/test-support';
import { parseWebConfig, type WebConfig } from './config';
import { createDeps, type WebDeps } from './deps';
import { cookieValue, SESSION_COOKIE, unseal, type Session } from './session';

export const ADMIN_KEY = 'web-test-admin-key-web-test-admin-key-01';
export const SESSION_SECRET_HEX = 'ab'.repeat(32);
export const ORIGIN = 'http://localhost:3000';

export interface WebHarness {
  h: Harness;
  config: WebConfig;
  deps: WebDeps;
  key: Buffer;
  sellerId: string;
  sellerKey: string;
  logs: string[];
  /** The real demo seller app (fake AI), when `withSeller` was set. */
  seller: RunningSeller | undefined;
  /** The browser's cookie jar: `pp402_session`, updated from every `Set-Cookie`. */
  jar: { value: string | undefined };
  request(path: string, init?: { method?: string; body?: unknown; origin?: string | null; cookie?: string | null; headers?: Record<string, string> }): Request;
  /** Stores the session cookie from a response, if it sets one. */
  keep(response: Response): Response;
  session(): Session | undefined;
  close(): Promise<void>;
}

export async function createWebHarness(
  options: { env?: Record<string, string>; fetch?: typeof fetch; withSeller?: boolean } = {},
): Promise<WebHarness> {
  const h = createHarness({ config: { adminApiKey: ADMIN_KEY } });
  const url = await h.url();
  const seller = h.addSeller();
  const running = options.withSeller ? await startSeller({ port: 0, facilitatorUrl: url, sellerApiKey: seller.key, ai: new FakeSellerAi() }) : undefined;
  const config = parseWebConfig({
    WEB_PUBLIC_URL: ORIGIN,
    FACILITATOR_URL: url,
    FACILITATOR_ADMIN_KEY: ADMIN_KEY,
    WEB_SELLER_API_KEY: seller.key,
    WEB_SESSION_SECRET: SESSION_SECRET_HEX,
    SELLER_URL: running?.url ?? 'http://127.0.0.1:9',
    ANTHROPIC_MODEL: 'claude-test-model',
    WEB_DECISION_LAYER: 'off',
    ...options.env,
  });
  const logs: string[] = [];
  const deps = createDeps(config, { log: (line) => logs.push(line), ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const key = Buffer.from(SESSION_SECRET_HEX, 'hex');
  const jar: WebHarness['jar'] = { value: undefined };
  return {
    h,
    config,
    deps,
    key,
    sellerId: seller.sellerId,
    sellerKey: seller.key,
    logs,
    seller: running,
    jar,
    request(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      const origin = init.origin === undefined ? ORIGIN : init.origin;
      if (origin !== null) headers['origin'] = origin;
      const cookie = init.cookie === undefined ? (jar.value === undefined ? null : `${SESSION_COOKIE}=${jar.value}`) : init.cookie;
      if (cookie !== null) headers['cookie'] = cookie;
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      return new Request(`${ORIGIN}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
      });
    },
    keep(response) {
      const set = response.headers.get('set-cookie');
      const value = cookieValue(set?.split(';')[0] ?? null, SESSION_COOKIE);
      if (value !== undefined) jar.value = value;
      return response;
    },
    session() {
      return jar.value === undefined ? undefined : unseal(jar.value, key);
    },
    async close() {
      await running?.close();
      await h.close();
    },
  };
}

export async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
