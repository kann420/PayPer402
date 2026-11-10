import { describe, expect, it } from 'vitest';
import { PayPalClient } from './client';
import { SANDBOX_API_BASE } from './config';
import { PayPalApiError, PayPalNetworkError, classifyPayPalError } from './errors';
import { centsToUsdString, usdStringToCents } from './money';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const TOKEN_RESPONSE = () => json(200, { access_token: 'tok_1', expires_in: 3600, token_type: 'Bearer' });

/** A fake fetch that answers token requests itself and the rest from a queue. */
function fakeFetch(queue: Responder[], options: { tokens?: () => Response } = {}) {
  const calls: RecordedCall[] = [];
  let tokenCalls = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    if (call.url.endsWith('/v1/oauth2/token')) {
      tokenCalls += 1;
      return (options.tokens ?? TOKEN_RESPONSE)();
    }
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected call ${call.method} ${call.url}`);
    return next(call);
  };
  return {
    impl: impl as typeof fetch,
    calls,
    apiCalls: () => calls.filter((c) => !c.url.endsWith('/v1/oauth2/token')),
    tokenCalls: () => tokenCalls,
  };
}

function client(fetchImpl: typeof fetch, clock = { now: 1_000_000 }) {
  return new PayPalClient({ clientId: 'cid', clientSecret: 'csecret', fetch: fetchImpl, now: () => clock.now });
}

const capture = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'CAP1',
  status,
  amount: { currency_code: 'USD', value: '12.34' },
  seller_receivable_breakdown: {
    gross_amount: { currency_code: 'USD', value: '12.34' },
    paypal_fee: { currency_code: 'USD', value: '0.92' },
    net_amount: { currency_code: 'USD', value: '11.42' },
  },
  ...extra,
});

const order = (status: string, captures?: unknown[]) => ({
  id: 'ORDER1',
  status,
  purchase_units: [{ reference_id: 'default', ...(captures ? { payments: { captures } } : {}) }],
});

const chargeInput = {
  vaultId: 'vault_1',
  amountCents: 1234,
  requestId: 'stl_abc',
  invoiceId: 'stl_abc',
  description: 'PayPer402 usage: 3 paid calls',
};

describe('access token', () => {
  it('requests a token with basic auth and caches it until expires_in - 60', async () => {
    const clock = { now: 1_000_000 };
    const fake = fakeFetch([]);
    const c = client(fake.impl, clock);
    expect(await c.getAccessToken()).toBe('tok_1');
    const [call] = fake.calls;
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v1/oauth2/token`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['authorization']).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call?.body).toBe('grant_type=client_credentials');

    clock.now += 3600 - 61;
    await c.getAccessToken();
    expect(fake.tokenCalls()).toBe(1);
    clock.now += 1;
    await c.getAccessToken();
    expect(fake.tokenCalls()).toBe(2);
  });

  it('single-flights concurrent token requests', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      await gate;
      return TOKEN_RESPONSE();
    }) as typeof fetch;
    const c = client(impl);
    const all = Promise.all([c.getAccessToken(), c.getAccessToken(), c.getAccessToken()]);
    release();
    expect(await all).toEqual(['tok_1', 'tok_1', 'tok_1']);
    expect(calls).toHaveLength(1);
  });

  it('refreshes the token once and retries once on a 401', async () => {
    let n = 0;
    const fake = fakeFetch([() => json(401, { error: 'invalid_token' }), () => json(200, { id: 'ST1', status: 'APPROVED' })], {
      tokens: () => {
        n += 1;
        return json(200, { access_token: `tok_${n}`, expires_in: 3600 });
      },
    });
    const c = client(fake.impl);
    expect(await c.getSetupToken('ST1')).toEqual({ id: 'ST1', status: 'APPROVED' });
    const api = fake.apiCalls();
    expect(api.map((call) => call.headers['authorization'])).toEqual(['Bearer tok_1', 'Bearer tok_2']);
  });

  it('gives up after the second 401', async () => {
    const fake = fakeFetch([() => json(401, { error: 'invalid_token' }), () => json(401, { error: 'invalid_token' })]);
    await expect(client(fake.impl).getSetupToken('ST1')).rejects.toMatchObject({ httpStatus: 401 });
    expect(fake.apiCalls()).toHaveLength(2);
  });

  it('never puts the secret or the token in errors', async () => {
    const fake = fakeFetch([() => json(400, { name: 'INVALID_REQUEST', message: 'bad', details: [{ issue: 'X' }] })]);
    const err = await client(fake.impl).getSetupToken('ST1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    const text = JSON.stringify({ ...(err as object), message: (err as Error).message });
    expect(text).not.toContain('csecret');
    expect(text).not.toContain('tok_1');
  });
});

describe('vault', () => {
  it('creates a setup token with the documented body and returns the approve link', async () => {
    const fake = fakeFetch([
      () =>
        json(201, {
          id: 'ST1',
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: 'https://x/self' },
            { rel: 'approve', href: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=1' },
          ],
        }),
    ]);
    const result = await client(fake.impl).createSetupToken({
      returnUrl: 'http://localhost:4020/paypal/return?state=s1',
      cancelUrl: 'http://localhost:4020/paypal/cancel?state=s1',
      description: 'desc',
      brandName: 'PayPer402',
      requestId: 'req_1',
    });
    expect(result).toEqual({
      id: 'ST1',
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=1',
    });
    const [call] = fake.apiCalls();
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v3/vault/setup-tokens`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['paypal-request-id']).toBe('req_1');
    expect(call?.headers['authorization']).toBe('Bearer tok_1');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call?.body ?? '')).toEqual({
      payment_source: {
        paypal: {
          description: 'desc',
          usage_type: 'MERCHANT',
          usage_pattern: 'UNSCHEDULED_POSTPAID',
          customer_type: 'CONSUMER',
          experience_context: {
            brand_name: 'PayPer402',
            shipping_preference: 'NO_SHIPPING',
            return_url: 'http://localhost:4020/paypal/return?state=s1',
            cancel_url: 'http://localhost:4020/paypal/cancel?state=s1',
          },
        },
      },
    });
  });

  it('fails clearly when the setup token has no approve link', async () => {
    const fake = fakeFetch([() => json(201, { id: 'ST1', status: 'CREATED', links: [] })]);
    await expect(
      client(fake.impl).createSetupToken({ returnUrl: 'r', cancelUrl: 'c', description: 'd', brandName: 'b', requestId: 'q' }),
    ).rejects.toBeInstanceOf(PayPalNetworkError);
  });

  it('reads a setup token', async () => {
    const fake = fakeFetch([() => json(200, { id: 'ST/1', status: 'APPROVED' })]);
    expect(await client(fake.impl).getSetupToken('ST/1')).toEqual({ id: 'ST/1', status: 'APPROVED' });
    const [call] = fake.apiCalls();
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v3/vault/setup-tokens/ST%2F1`);
    expect(call?.method).toBe('GET');
    expect(call?.body).toBeUndefined();
    expect(call?.headers['paypal-request-id']).toBeUndefined();
  });

  it('creates a payment token from a setup token', async () => {
    const fake = fakeFetch([
      () =>
        json(200, {
          id: 'PT1',
          customer: { id: 'CUST1' },
          payment_source: { paypal: { email_address: 'buyer@example.com' } },
        }),
    ]);
    expect(await client(fake.impl).createPaymentToken('ST1', 'state_1')).toEqual({
      id: 'PT1',
      customerId: 'CUST1',
      payerEmail: 'buyer@example.com',
    });
    const [call] = fake.apiCalls();
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v3/vault/payment-tokens`);
    expect(call?.headers['paypal-request-id']).toBe('state_1');
    expect(JSON.parse(call?.body ?? '')).toEqual({ payment_source: { token: { id: 'ST1', type: 'SETUP_TOKEN' } } });
  });

  it('gets and deletes a payment token', async () => {
    const fake = fakeFetch([() => json(200, { id: 'PT1' }), () => new Response(null, { status: 204 })]);
    const c = client(fake.impl);
    expect(await c.getPaymentToken('PT1')).toEqual({ id: 'PT1' });
    await expect(c.deletePaymentToken('PT1')).resolves.toBeUndefined();
    const [get, del] = fake.apiCalls();
    expect(get?.url).toBe(`${SANDBOX_API_BASE}/v3/vault/payment-tokens/PT1`);
    expect(del?.url).toBe(`${SANDBOX_API_BASE}/v3/vault/payment-tokens/PT1`);
    expect(del?.method).toBe('DELETE');
  });

  it('exposes a 404 on a revoked payment token as httpStatus, classified revocation by issue', async () => {
    const fake = fakeFetch([
      () => json(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'TOKEN_NOT_FOUND' }], debug_id: 'dbg1' }),
    ]);
    const err = await client(fake.impl).getPaymentToken('PT1').catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 404, issues: ['TOKEN_NOT_FOUND'], debugId: 'dbg1', method: 'GET' });
    expect(classifyPayPalError(err)).toBe('revocation');
  });
});

describe('token ids never reach error messages', () => {
  const secret = 'PT-SECRET-123';
  const leaks = (err: unknown) => {
    const e = err as { message: string; path?: string };
    const text = `${e.message} ${e.path ?? ''}`;
    return text.includes(secret) || text.includes('ST-SECRET-9');
  };

  it.each([
    ['getPaymentToken', (c: PayPalClient) => c.getPaymentToken(secret), '/v3/vault/payment-tokens/*', secret],
    ['deletePaymentToken', (c: PayPalClient) => c.deletePaymentToken(secret), '/v3/vault/payment-tokens/*', secret],
    ['getSetupToken', (c: PayPalClient) => c.getSetupToken('ST-SECRET-9'), '/v3/vault/setup-tokens/*', 'ST-SECRET-9'],
  ])('%s: a 500 shows a redacted path and message', async (_name, run, display, id) => {
    const fake = fakeFetch([
      () => json(500, { name: 'INTERNAL_SERVER_ERROR', message: `Failed for ${id}` }),
    ]);
    const err = await run(client(fake.impl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).path).toBe(display);
    expect(leaks(err)).toBe(false);
    // The request itself still went to the real URL.
    expect(fake.apiCalls()[0]?.url).toMatch(/SECRET/);
  });

  it('redacts network errors and unparseable responses too', async () => {
    const fake = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('<html>', { status: 200 }),
    ]);
    const c = client(fake.impl);
    const net = await c.getPaymentToken(secret).catch((e: unknown) => e);
    const parse = await c.deletePaymentToken(secret).catch((e: unknown) => e);
    expect(net).toBeInstanceOf(PayPalNetworkError);
    expect(parse).toBeInstanceOf(PayPalNetworkError);
    expect(leaks(net)).toBe(false);
    expect(leaks(parse)).toBe(false);
  });
});

describe('orders', () => {
  it('charges a vaulted wallet that completes directly', async () => {
    const fake = fakeFetch([() => json(201, order('COMPLETED', [capture('COMPLETED')]))]);
    const result = await client(fake.impl).chargeVaultedWallet(chargeInput);
    expect(result).toEqual({
      orderId: 'ORDER1',
      orderStatus: 'COMPLETED',
      capture: { id: 'CAP1', status: 'COMPLETED', amountCents: 1234, feeCents: 92, netCents: 1142 },
    });
    const calls = fake.apiCalls();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v2/checkout/orders`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['paypal-request-id']).toBe('stl_abc');
    expect(call?.headers['prefer']).toBe('return=representation');
    expect(JSON.parse(call?.body ?? '')).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value: '12.34' },
          invoice_id: 'stl_abc',
          custom_id: 'stl_abc',
          description: 'PayPer402 usage: 3 paid calls',
        },
      ],
      payment_source: { paypal: { vault_id: 'vault_1' } },
    });
  });

  it('truncates the description to 127 characters', async () => {
    const fake = fakeFetch([() => json(201, order('COMPLETED', [capture('COMPLETED')]))]);
    await client(fake.impl).chargeVaultedWallet({ ...chargeInput, description: 'x'.repeat(200) });
    const body = JSON.parse(fake.apiCalls()[0]?.body ?? '') as { purchase_units: { description: string }[] };
    expect(body.purchase_units[0]?.description).toHaveLength(127);
  });

  it('captures an order that comes back CREATED or APPROVED', async () => {
    const fake = fakeFetch([
      () => json(201, order('APPROVED')),
      () => json(201, order('COMPLETED', [capture('COMPLETED')])),
    ]);
    const result = await client(fake.impl).chargeVaultedWallet(chargeInput);
    expect(result.capture?.status).toBe('COMPLETED');
    const [, cap] = fake.apiCalls();
    expect(cap?.url).toBe(`${SANDBOX_API_BASE}/v2/checkout/orders/ORDER1/capture`);
    expect(cap?.method).toBe('POST');
    expect(cap?.headers['paypal-request-id']).toBe('stl_abc:capture');
    expect(cap?.headers['prefer']).toBe('return=representation');
  });

  it('maps a PENDING capture with its reason', async () => {
    const fake = fakeFetch([
      () => json(201, order('COMPLETED', [capture('PENDING', { status_details: { reason: 'PENDING_REVIEW' } })])),
    ]);
    const result = await client(fake.impl).chargeVaultedWallet(chargeInput);
    expect(result.capture).toMatchObject({ status: 'PENDING', statusReason: 'PENDING_REVIEW' });
  });

  it('returns an order without a capture as-is', async () => {
    const fake = fakeFetch([() => json(200, order('PAYER_ACTION_REQUIRED'))]);
    expect(await client(fake.impl).chargeVaultedWallet(chargeInput)).toEqual({
      orderId: 'ORDER1',
      orderStatus: 'PAYER_ACTION_REQUIRED',
    });
  });

  it('gets an order and maps it the same way', async () => {
    const fake = fakeFetch([() => json(200, order('COMPLETED', [capture('COMPLETED')]))]);
    expect((await client(fake.impl).getOrder('ORDER1')).capture?.id).toBe('CAP1');
    const [call] = fake.apiCalls();
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v2/checkout/orders/ORDER1`);
    expect(call?.method).toBe('GET');
    expect(call?.headers['prefer']).toBe('return=representation');
  });

  it('gets a capture from Payments v2 with its invoice, order and times', async () => {
    const fake = fakeFetch([
      () =>
        json(
          200,
          capture('COMPLETED', {
            invoice_id: 'stl_abc',
            custom_id: 'stl_abc',
            create_time: '2026-11-10T15:26:01Z',
            update_time: '2026-11-10T15:26:02Z',
            supplementary_data: { related_ids: { order_id: 'ORDER1' } },
          }),
        ),
    ]);
    expect(await client(fake.impl).getCapture('CAP/1')).toEqual({
      id: 'CAP1',
      status: 'COMPLETED',
      amountCents: 1234,
      feeCents: 92,
      netCents: 1142,
      currency: 'USD',
      invoiceId: 'stl_abc',
      customId: 'stl_abc',
      orderId: 'ORDER1',
      createTime: '2026-11-10T15:26:01Z',
      updateTime: '2026-11-10T15:26:02Z',
    });
    const [call] = fake.apiCalls();
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v2/payments/captures/CAP%2F1`);
    expect(call?.method).toBe('GET');
  });

  it('rejects a capture response without an amount currency', async () => {
    const fake = fakeFetch([() => json(200, { id: 'CAP1', status: 'COMPLETED', amount: { value: '1.00' } })]);
    await expect(client(fake.impl).getCapture('CAP1')).rejects.toBeInstanceOf(PayPalNetworkError);
  });

  it('surfaces a missing capture as a 404 PayPalApiError', async () => {
    const fake = fakeFetch([() => json(404, { name: 'RESOURCE_NOT_FOUND', message: 'not found', details: [{ issue: 'INVALID_RESOURCE_ID' }] })]);
    await expect(client(fake.impl).getCapture('NOPE')).rejects.toMatchObject({ httpStatus: 404, issues: ['INVALID_RESOURCE_ID'] });
  });

  it('classifies AGREEMENT_ALREADY_CANCELLED as revocation', async () => {
    const fake = fakeFetch([
      () =>
        json(422, {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed',
          details: [{ issue: 'AGREEMENT_ALREADY_CANCELLED', description: 'cancelled' }],
          debug_id: 'dbg2',
        }),
    ]);
    const err = await client(fake.impl).chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({
      httpStatus: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issues: ['AGREEMENT_ALREADY_CANCELLED'],
      method: 'POST',
      path: '/v2/checkout/orders',
      debugId: 'dbg2',
    });
    expect((err as PayPalApiError).orderId).toBeUndefined();
    expect(classifyPayPalError(err)).toBe('revocation');
  });

  it('classifies INSTRUMENT_DECLINED on the capture leg as decline and fills in the order id', async () => {
    const fake = fakeFetch([
      () => json(201, order('CREATED')),
      () => json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }),
    ]);
    const err = await client(fake.impl).chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    expect(classifyPayPalError(err)).toBe('decline');
    expect(err).toMatchObject({ orderId: 'ORDER1', path: '/v2/checkout/orders/ORDER1/capture' });
  });

  it('classifies DUPLICATE_INVOICE_ID as duplicate', async () => {
    const fake = fakeFetch([() => json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'DUPLICATE_INVOICE_ID' }] })]);
    const err = await client(fake.impl).chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    expect(classifyPayPalError(err)).toBe('duplicate');
  });

  it('classifies a 500, a 429 and a network error as transient', async () => {
    const fake = fakeFetch([
      () => json(500, { name: 'INTERNAL_SERVER_ERROR' }),
      () => json(429, { name: 'RATE_LIMIT_REACHED' }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('<html>oops</html>', { status: 200 }),
    ]);
    const c = client(fake.impl);
    const e500 = await c.chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    const e429 = await c.chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    const eNet = await c.chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    const eParse = await c.chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    expect([e500, e429, eNet, eParse].map(classifyPayPalError)).toEqual(['transient', 'transient', 'transient', 'transient']);
    expect(eNet).toBeInstanceOf(PayPalNetworkError);
    expect(eParse).toBeInstanceOf(PayPalNetworkError);
  });

  it('classifies other 4xx as other, and non-PayPal errors as other', async () => {
    const fake = fakeFetch([() => json(400, { name: 'INVALID_REQUEST', details: [{ issue: 'MISSING_REQUIRED_PARAMETER' }] })]);
    const err = await client(fake.impl).chargeVaultedWallet(chargeInput).catch((e: unknown) => e);
    expect(classifyPayPalError(err)).toBe('other');
    expect(classifyPayPalError(new Error('x'))).toBe('other');
  });

  it('times out a hanging request as a network error', async () => {
    const impl = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/oauth2/token')) return Promise.resolve(TOKEN_RESPONSE());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const c = new PayPalClient({ clientId: 'cid', clientSecret: 'cs', fetch: impl, timeoutMs: 5 });
    const err = await c.getOrder('O1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalNetworkError);
    expect((err as Error).message).toContain('timed out');
  });

  it('refuses a non-positive amount without a network call', async () => {
    const fake = fakeFetch([]);
    await expect(client(fake.impl).chargeVaultedWallet({ ...chargeInput, amountCents: 0 })).rejects.toThrow(RangeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('webhook verification', () => {
  const headers = {
    'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT',
    'Paypal-Transmission-Id': 'tx-1',
    'paypal-transmission-sig': 'sig==',
    'paypal-transmission-time': '2026-10-16T00:00:00Z',
  };
  // Deliberately unusual spacing and key order: it must reach PayPal byte for byte.
  const rawBody = '{"id":"WH-1",  "event_type":"VAULT.PAYMENT-TOKEN.DELETED","resource":{"id":"PT1"},"z":1.50}';

  it('posts the raw body verbatim and returns true on SUCCESS', async () => {
    const fake = fakeFetch([() => json(200, { verification_status: 'SUCCESS' })]);
    expect(await client(fake.impl).verifyWebhookSignature({ headers, rawBody, webhookId: 'WHID' })).toBe(true);
    const [call] = fake.apiCalls();
    expect(call?.url).toBe(`${SANDBOX_API_BASE}/v1/notifications/verify-webhook-signature`);
    expect(call?.method).toBe('POST');
    expect(call?.body).toBe(
      '{"auth_algo":"SHA256withRSA","cert_url":"https://api.sandbox.paypal.com/v1/notifications/certs/CERT",' +
        '"transmission_id":"tx-1","transmission_sig":"sig==","transmission_time":"2026-10-16T00:00:00Z",' +
        `"webhook_id":"WHID","webhook_event":${rawBody}}`,
    );
  });

  it('returns false on FAILURE and on a 4xx answer', async () => {
    const fake = fakeFetch([
      () => json(200, { verification_status: 'FAILURE' }),
      () => json(400, { name: 'VALIDATION_ERROR' }),
    ]);
    const c = client(fake.impl);
    expect(await c.verifyWebhookSignature({ headers, rawBody, webhookId: 'WHID' })).toBe(false);
    expect(await c.verifyWebhookSignature({ headers, rawBody, webhookId: 'WHID' })).toBe(false);
  });

  it('throws on a transient failure so PayPal retries', async () => {
    const fake = fakeFetch([() => json(503, { name: 'SERVICE_UNAVAILABLE' })]);
    await expect(client(fake.impl).verifyWebhookSignature({ headers, rawBody, webhookId: 'WHID' })).rejects.toBeInstanceOf(
      PayPalApiError,
    );
  });

  it('returns false without a network call for missing headers or a non-JSON body', async () => {
    const fake = fakeFetch([]);
    const c = client(fake.impl);
    const { 'paypal-transmission-sig': _omit, ...partial } = headers;
    expect(await c.verifyWebhookSignature({ headers: partial, rawBody, webhookId: 'WHID' })).toBe(false);
    expect(await c.verifyWebhookSignature({ headers, rawBody: 'not json', webhookId: 'WHID' })).toBe(false);
    expect(await c.verifyWebhookSignature({ headers, rawBody: '[1,2]', webhookId: 'WHID' })).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('money', () => {
  it('formats cents', () => {
    expect(centsToUsdString(0)).toBe('0.00');
    expect(centsToUsdString(1)).toBe('0.01');
    expect(centsToUsdString(99)).toBe('0.99');
    expect(centsToUsdString(100)).toBe('1.00');
    expect(centsToUsdString(123456789)).toBe('1234567.89');
    expect(() => centsToUsdString(-1)).toThrow(RangeError);
    expect(() => centsToUsdString(1.5)).toThrow(RangeError);
    expect(() => centsToUsdString(Number.NaN)).toThrow(RangeError);
  });

  it('parses strict D.CC strings', () => {
    expect(usdStringToCents('0.00')).toBe(0);
    expect(usdStringToCents('0.01')).toBe(1);
    expect(usdStringToCents('0.5')).toBe(50);
    expect(usdStringToCents('7')).toBe(700);
    expect(usdStringToCents('12.34')).toBe(1234);
    for (const bad of ['', '.5', '1.', '1.234', '-1.00', '+1', '01.00', '1e2', ' 1.00', '1,00']) {
      expect(() => usdStringToCents(bad)).toThrow(TypeError);
    }
  });
});

describe('sandbox guard', () => {
  it('refuses the live host', () => {
    expect(
      () => new PayPalClient({ clientId: 'a', clientSecret: 'b', apiBase: 'https://api-m.paypal.com' }),
    ).toThrow(/Refusing/);
  });
});
