import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { priceToCents } from '@payper402/scheme-paypal';
import { SELLER_AI_BETAS, SUMMARIZE_SYSTEM, TRANSLATE_SYSTEM, createClaudeSellerAi, SellerAiError } from './ai';
import { newsroomArticle } from './app';
import { ConfigError, loadSellerConfig } from './config';
import { ANALYST_NOTES, ARTICLES, articlesFor, wordCount } from './data/news';
import { QUOTE_ROWS, dailyMove, priceOn, quoteAt, utcDate } from './data/quotes';
import { SERVICES, TOPICS, catalog, routesConfig, translateBody } from './services';

describe('services table', () => {
  it('every route config price equals the catalog price, and every service is protected', () => {
    const routes = routesConfig('sel_x');
    const listed = catalog({ name: 'Acme Data', payTo: 'sel_x' });
    expect(Object.keys(routes).sort()).toEqual(SERVICES.map((s) => `${s.method} ${s.path}`).sort());
    for (const service of listed.services) {
      const route = routes[`${service.method} ${service.path}`];
      expect(route).toBeDefined();
      const accepts = route?.accepts;
      if (!accepts || Array.isArray(accepts)) throw new Error('expected one payment option');
      expect(accepts).toMatchObject({ scheme: 'batch-settlement', network: 'paypal:sandbox', payTo: 'sel_x' });
      if (typeof accepts.price === 'function') throw new Error('expected a static price');
      expect(priceToCents(accepts.price)).toBe(service.priceCents);
      expect(route).toMatchObject({ description: service.description, mimeType: 'application/json' });
    }
  });

  it('lists the four services at the design-spec prices', () => {
    expect(SERVICES.map((s) => [s.id, s.priceCents])).toEqual([
      ['quote', 2],
      ['summarize', 5],
      ['translate', 1],
      ['premium_news', 25],
    ]);
    expect(catalog({ name: 'Acme Data', payTo: 'sel_x' })).toMatchObject({
      seller: { name: 'Acme Data', payTo: 'sel_x' },
      scheme: 'batch-settlement',
      network: 'paypal:sandbox',
      asset: 'USD',
    });
  });
});

describe('quote formula', () => {
  const day = Date.UTC(2026, 9, 16, 9, 30, 15);

  it('is deterministic per UTC day, with d within ±4%', () => {
    const { asOf: _morning, ...morning } = quoteAt('KC', day);
    const { asOf: _night, ...night } = quoteAt('KC', Date.UTC(2026, 9, 16, 23, 59, 59));
    expect(night).toEqual(morning);
    for (let i = 0; i < 400; i += 1) {
      const date = utcDate(day + i * 86_400_000);
      for (const symbol of ['KC', 'CC', 'SB', 'CT'] as const) {
        const d = dailyMove(date, symbol);
        expect(Math.abs(d)).toBeLessThanOrEqual(0.04);
      }
    }
    expect(dailyMove('2026-10-16', 'KC')).not.toBe(dailyMove('2026-10-17', 'KC'));
  });

  it('uses the previous UTC day for previousClose and rounds to 2 decimals', () => {
    const quote = quoteAt('CC', day);
    expect(quote.price).toBe(priceOn('2026-10-16', 'CC'));
    expect(quote.previousClose).toBe(priceOn('2026-10-15', 'CC'));
    expect(quote.change).toBe(Math.round((quote.price - quote.previousClose) * 100) / 100);
    for (const value of [quote.price, quote.previousClose, quote.change, quote.changePercent]) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
    expect(quote).toMatchObject({ symbol: 'CC', currency: 'USD', name: QUOTE_ROWS.CC.name, asOf: '2026-10-16T09:30:00.000Z' });
  });
});

describe('newsroom fixtures', () => {
  it('has 2 or 3 articles per topic, 120 to 250 words each, unique slugs, and short analyst notes', () => {
    for (const topic of TOPICS) {
      expect(articlesFor(topic).length).toBeGreaterThanOrEqual(2);
      expect(articlesFor(topic).length).toBeLessThanOrEqual(3);
      const words = wordCount(ANALYST_NOTES[topic]);
      expect(words).toBeGreaterThanOrEqual(40);
      expect(words).toBeLessThanOrEqual(80);
    }
    for (const article of ARTICLES) {
      const words = wordCount(article.body);
      expect(words, article.slug).toBeGreaterThanOrEqual(120);
      expect(words, article.slug).toBeLessThanOrEqual(250);
    }
    expect(new Set(ARTICLES.map((a) => a.slug)).size).toBe(ARTICLES.length);
  });
});

describe('summarize URL check', () => {
  const origin = 'https://seller.example';
  const slug = ARTICLES[0]?.slug ?? '';

  it('accepts the seller origin plus a known slug', () => {
    expect(newsroomArticle(origin, `${origin}/news/${slug}`)?.slug).toBe(slug);
  });

  it.each([
    ['another origin', `https://other.example/news/${slug}`],
    ['http versus https', `http://seller.example/news/${slug}`],
    ['another port', `https://seller.example:8443/news/${slug}`],
    ['an unknown slug', `${origin}/news/no-such-article`],
    ['a path traversal attempt', `${origin}/news/../v1/quote`],
    ['an encoded traversal', `${origin}/news/%2e%2e/${slug}`],
    ['a nested path', `${origin}/news/${slug}/extra`],
    ['a non-URL', 'not a url'],
  ])('rejects %s', (_label, value) => {
    expect(newsroomArticle(origin, value)).toBeUndefined();
  });
});

describe('translate validation', () => {
  it.each(['Vietnamese', 'vi', 'Brazilian Portuguese', 'zh-Hant'])('accepts the target language %s', (targetLanguage) => {
    expect(translateBody.safeParse({ text: 'hi', targetLanguage }).success).toBe(true);
  });

  it.each(['', '1abc', 'Viet;namese', 'x'.repeat(33), ' leading'])('rejects the target language %j', (targetLanguage) => {
    expect(translateBody.safeParse({ text: 'hi', targetLanguage }).success).toBe(false);
  });

  it('limits the text to 4000 characters', () => {
    expect(translateBody.safeParse({ text: 'a'.repeat(4000), targetLanguage: 'vi' }).success).toBe(true);
    expect(translateBody.safeParse({ text: 'a'.repeat(4001), targetLanguage: 'vi' }).success).toBe(false);
  });
});

describe('config', () => {
  const key = `pp402_sel_${'a'.repeat(43)}`;

  it('applies the defaults', () => {
    expect(loadSellerConfig({ SELLER_API_KEY: key })).toEqual({
      port: 4021,
      publicUrl: 'http://localhost:4021',
      facilitatorUrl: 'http://localhost:4020',
      sellerApiKey: key,
      anthropicModel: 'claude-opus-5-5',
    });
  });

  it('requires the seller key and never echoes values', () => {
    expect(() => loadSellerConfig({})).toThrow(ConfigError);
    try {
      loadSellerConfig({ SELLER_API_KEY: 'pp402_sel_short-secret' });
    } catch (err) {
      expect(String(err)).toContain('SELLER_API_KEY');
      expect(String(err)).not.toContain('short-secret');
    }
  });
});

interface Captured {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeClient(reply: { status: number; body: Record<string, unknown> }) {
  const captured: Captured[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    captured.push({ headers, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  return { client: new Anthropic({ apiKey: 'sk-ant-test-not-a-key', fetch, maxRetries: 0 }), captured };
}

const messageBody = (content: Record<string, unknown>[], stopReason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe('createClaudeSellerAi', () => {
  it('sends the model, effort low, max_tokens, the fallbacks beta and field, and the static system prompt', async () => {
    const { client, captured } = fakeClient({
      status: 200,
      body: messageBody([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'A short summary.' }]),
    });
    const ai = createClaudeSellerAi(client, 'claude-opus-5-5');
    expect(await ai.summarize({ title: 'Rain "delays"', text: 'Body text', maxWords: 50 })).toBe('A short summary.');
    expect(await ai.translate({ text: 'Hello', targetLanguage: 'Vietnamese' })).toBe('A short summary.');
    const [summarize, translate] = captured;
    expect(summarize?.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: SUMMARIZE_SYSTEM,
      messages: [{ role: 'user', content: 'Summarize in at most 50 words.\n<article title="Rain &quot;delays&quot;">\nBody text\n</article>' }],
    });
    expect(summarize?.headers['anthropic-beta']).toBe(SELLER_AI_BETAS.join(','));
    expect(translate?.body).toMatchObject({
      system: TRANSLATE_SYSTEM,
      messages: [{ role: 'user', content: 'Translate into Vietnamese.\n<text>\nHello\n</text>' }],
    });
  });

  it.each([
    ['refusal', messageBody([{ type: 'text', text: 'no' }], 'refusal')],
    ['max_tokens', messageBody([{ type: 'text', text: 'cut' }], 'max_tokens')],
    ['no text block', messageBody([{ type: 'thinking', thinking: '', signature: 's' }])],
  ])('throws on %s', async (_label, body) => {
    const ai = createClaudeSellerAi(fakeClient({ status: 200, body }).client, 'claude-opus-5-5');
    await expect(ai.summarize({ title: 't', text: 'x', maxWords: 30 })).rejects.toBeInstanceOf(SellerAiError);
  });

  it('throws a SellerAiError with the status only on a typed API error', async () => {
    const { client } = fakeClient({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'raw body detail' } } });
    const ai = createClaudeSellerAi(client, 'claude-opus-5-5');
    const err = await ai.translate({ text: 'x', targetLanguage: 'vi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SellerAiError);
    expect((err as Error).message).toBe('The model request failed (HTTP 529)');
    expect((err as Error).message).not.toContain('raw body detail');
    expect((err as Error).message).not.toContain('sk-ant');
  });
});
