import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTICLES } from './data/news';
import { startSeller, SellerStartError } from './server';
import { SERVICES } from './services';
import { PAY_TO, call, paidCall, startTestSeller, type CallOptions, type TestSeller } from './test-support';

const validCalls: Record<string, CallOptions> = {
  quote: { query: { symbol: 'KC' } },
  summarize: { body: { url: '' } },
  translate: { body: { text: 'Coffee prices rose.', targetLanguage: 'Vietnamese' } },
  premium_news: { query: { topic: 'cocoa' } },
};

describe('demo seller over HTTP', () => {
  let seller: TestSeller;
  const article = ARTICLES[0];
  if (!article) throw new Error('no articles');

  beforeEach(async () => {
    seller = await startTestSeller();
    validCalls['summarize'] = { body: { url: `${seller.url}/news/${article.slug}`, maxWords: 60 } };
  });

  afterEach(async () => {
    await seller.close();
  });

  it.each(SERVICES.map((s) => [s.id, s] as const))('%s answers an unpaid request with 402 and the catalog price', async (id, service) => {
    const res = await call(seller, service.method, service.path, validCalls[id]);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '');
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: 'batch-settlement',
        network: 'paypal:sandbox',
        asset: 'USD',
        amount: String(service.priceCents),
        payTo: PAY_TO,
      }),
    ]);
    expect(seller.ledger.size).toBe(0);
  });

  it.each(SERVICES.map((s) => [s.id, s] as const))('%s succeeds when paid and the ledger records the amount', async (id, service) => {
    const res = await paidCall(seller, service.method, service.path, validCalls[id]);
    expect(res.status).toBe(200);
    const settled = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '');
    expect(settled).toMatchObject({ success: true, amount: String(service.priceCents) });
    expect(seller.ledger.all()).toEqual([expect.objectContaining({ id: settled.transaction, amount: service.priceCents, payTo: PAY_TO })]);
  });

  it('returns the quote shape with related news on the seller origin', async () => {
    const res = await paidCall(seller, 'GET', '/v1/quote', { query: { symbol: 'KC' } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      symbol: 'KC',
      name: 'Coffee (Arabica) futures',
      unit: 'US cents per lb',
      currency: 'USD',
      asOf: '2026-10-16T12:34:00.000Z',
      source: 'Acme Data demo feed (simulated)',
      simulated: true,
    });
    const related = body['relatedNews'] as { url: string; publishedAt: string }[];
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(3);
    for (const item of related) {
      expect(item.url.startsWith(`${seller.url}/news/`)).toBe(true);
      expect(item.publishedAt).toBe('2026-10-16');
    }
  });

  it('summarize reads the article from memory and answers the summary', async () => {
    const res = await paidCall(seller, 'POST', '/v1/summarize', { body: { url: `${seller.url}/news/${article.slug}` } });
    expect(await res.json()).toMatchObject({
      url: `${seller.url}/news/${article.slug}`,
      title: article.title,
      summary: `Summary of ${article.title} in 120 words or fewer.`,
      words: 7 + article.title.split(' ').length,
    });
    expect(seller.ai.calls).toEqual([{ method: 'summarize', input: { title: article.title, text: article.body, maxWords: 120 } }]);
  });

  it('translate and premium news answer their shapes', async () => {
    const translated = await paidCall(seller, 'POST', '/v1/translate', { body: { text: 'Hello', targetLanguage: 'vi' } });
    expect(await translated.json()).toEqual({ targetLanguage: 'vi', translatedText: '[vi] Hello', characters: 5 });
    const premium = await paidCall(seller, 'GET', '/v1/news/premium', { query: { topic: 'sugar' } });
    const body = (await premium.json()) as { articles: { body: string }[]; analystNote: string; simulated: boolean };
    expect(body.articles.length).toBeGreaterThanOrEqual(2);
    expect(body.articles[0]?.body.length).toBeGreaterThan(100);
    expect(body.analystNote).toMatch(/^Our view/);
    expect(body.simulated).toBe(true);
  });

  describe('charging rule: nothing is recorded below a 2xx', () => {
    it('an invalid symbol answers 400 after a valid payment', async () => {
      const res = await paidCall(seller, 'GET', '/v1/quote', { query: { symbol: 'XX' } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed', issues: [expect.objectContaining({ path: 'symbol' })] });
      expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
      expect(seller.ledger.size).toBe(0);
    });

    it('a summarize URL outside the newsroom answers 400 unsupported_url', async () => {
      const res = await paidCall(seller, 'POST', '/v1/summarize', { body: { url: `https://elsewhere.example/news/${article.slug}` } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'unsupported_url',
        message: `Only pages from this seller's newsroom (${seller.url}/news/…) can be summarized.`,
      });
      expect(seller.ai.calls).toHaveLength(0);
      expect(seller.ledger.size).toBe(0);
    });

    it('an over-long translate text answers 400', async () => {
      const res = await paidCall(seller, 'POST', '/v1/translate', { body: { text: 'a'.repeat(4001), targetLanguage: 'vi' } });
      expect(res.status).toBe(400);
      expect(seller.ledger.size).toBe(0);
    });

    it('an AI failure answers 503 ai_unavailable', async () => {
      seller.ai.fail = true;
      const res = await paidCall(seller, 'POST', '/v1/translate', { body: { text: 'Hello', targetLanguage: 'vi' } });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'ai_unavailable' });
      expect(seller.ledger.size).toBe(0);
    });

    it('a malformed JSON body answers 400 invalid_json before payment', async () => {
      const res = await call(seller, 'POST', '/v1/summarize', { rawBody: '{"url": ' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json', message: 'The request body is not valid JSON' });
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(seller.ledger.size).toBe(0);
    });

    it('a body over 32 KB answers 413 body_too_large before payment', async () => {
      const res = await call(seller, 'POST', '/v1/translate', { body: { text: 'a'.repeat(33 * 1024), targetLanguage: 'vi' } });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'body_too_large' });
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(seller.ledger.size).toBe(0);
    });
  });

  it('answers an unknown route with 404 not_found', async () => {
    const res = await call(seller, 'GET', '/v1/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found' });
    expect((await call(seller, 'GET', '/v1/summarize')).status).toBe(404);
  });

  it('serves the catalog, newsroom pages and /healthz for free', async () => {
    const catalogRes = await call(seller, 'GET', '/v1/catalog');
    expect(catalogRes.status).toBe(200);
    const catalog = (await catalogRes.json()) as { seller: unknown; services: { id: string }[] };
    expect(catalog.seller).toEqual({ name: 'Acme Data', payTo: PAY_TO });
    expect(catalog.services.map((s) => s.id)).toEqual(['quote', 'summarize', 'translate', 'premium_news']);
    expect(await (await call(seller, 'GET', '/healthz')).json()).toEqual({ ok: true });
    const page = await call(seller, 'GET', `/news/${article.slug}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain(article.title);
    expect(html).toContain('Demo content from the Acme Data newsroom. Fictional.');
    expect(html).toContain('<time datetime="2026-10-16">');
    expect((await call(seller, 'GET', '/news/no-such-article')).status).toBe(404);
    expect(seller.ledger.size).toBe(0);
  });
});

describe('demo seller error handling', () => {
  it('a handler that throws answers 500 with no stack trace or details', async () => {
    // The quote handler reads the clock after payment was verified; a throwing clock makes it fail.
    const seller = await startTestSeller({
      now: () => {
        throw new Error('secret internal detail');
      },
    });
    try {
      const res = await paidCall(seller, 'GET', '/v1/quote', { query: { symbol: 'KC' } });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'internal_error', message: 'Internal error' });
      expect(text).not.toContain('secret internal detail');
      expect(text).not.toContain('at ');
      expect(seller.ledger.size).toBe(0);
    } finally {
      await seller.close();
    }
  });

  it('newsroom HTML is escaped', async () => {
    const { escapeHtml } = await import('./app');
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  });
});

describe('startSeller', () => {
  it('fails with a clear error when /v1/seller answers 401', async () => {
    const fetch401 = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    const started = startSeller({
      port: 0,
      facilitatorUrl: 'http://facilitator.test',
      sellerApiKey: `pp402_sel_${'a'.repeat(43)}`,
      ai: { summarize: async () => '', translate: async () => '' },
      fetch: fetch401,
    });
    await expect(started).rejects.toBeInstanceOf(SellerStartError);
    await expect(started).rejects.toThrow('The facilitator rejected the seller API key (HTTP 401)');
  });
});
