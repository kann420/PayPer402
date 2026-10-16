import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import type { z } from 'zod';
import type { SellerAi } from './ai';
import { ANALYST_NOTES, articleBySlug, articlesFor, wordCount, type Article } from './data/news';
import { DEMO_SOURCE, QUOTE_ROWS, quoteAt, utcDate } from './data/quotes';
import { SUMMARY_WORDS, catalog, premiumQuery, quoteQuery, routesConfig, summarizeBody, translateBody } from './services';

export interface SellerAppDeps {
  /** The seller id at the facilitator: the `payTo` of every route. */
  payTo: string;
  sellerName: string;
  /** External base URL, without a trailing slash: newsroom links and the summarize origin check. */
  publicUrl: string;
  /** An initialized resource server with the PayPal scheme registered. */
  resourceServer: x402ResourceServer;
  ai: SellerAi;
  /** Unix milliseconds, for the quote date and `asOf`. Defaults to `Date.now`. */
  now?: () => number;
}

/** A body limit of 32 KB, checked before payment (design spec §3.4). */
export const BODY_LIMIT = '32kb';
const RELATED_NEWS_MAX = 3;

interface ValidationIssue {
  path: string;
  message: string;
}

/** An error rendered as `{ error, message }` with an HTTP status. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[] | undefined;

  constructor(status: number, code: string, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    'validation_failed',
    'The request is invalid',
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

function handler(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** Runs a seller AI call; any failure becomes 503 `ai_unavailable` (never 502, see §3.4). */
async function withAi<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new HttpError(503, 'ai_unavailable', 'The summary and translation service is unavailable; you were not charged');
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Returns the article a summarize URL points to, or undefined. The URL must parse, have the
 * origin of `publicUrl`, and the path `/news/<slug>` of a known article. Nothing is fetched.
 */
export function newsroomArticle(publicUrl: string, value: string): Article | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(publicUrl).origin) return undefined;
  const match = /^\/news\/([a-z0-9-]{1,100})$/.exec(url.pathname);
  return match?.[1] === undefined ? undefined : articleBySlug(match[1]);
}

function newsPage(article: Article, date: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(article.title)}</title></head><body>`,
    `<article><h1>${escapeHtml(article.title)}</h1><p><time datetime="${date}">${date}</time></p>`,
    `<p>${escapeHtml(article.body)}</p></article>`,
    '<footer><p>Demo content from the Acme Data newsroom. Fictional.</p></footer>',
    '</body></html>',
  ].join('\n');
}

function errorHandler(): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...(err.issues === undefined ? {} : { issues: err.issues }),
      });
      return;
    }
    const parserError = err as { type?: unknown; status?: unknown };
    if (typeof parserError?.type === 'string' && typeof parserError.status === 'number') {
      if (parserError.type === 'entity.too.large') {
        res.status(413).json({ error: 'body_too_large', message: 'The request body is over 32 KB' });
        return;
      }
      if (parserError.status === 400) {
        res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON' });
        return;
      }
    }
    res.status(500).json({ error: 'internal_error', message: 'Internal error' });
  };
}

/** The demo seller's Express app (design spec §3). No I/O at import time. */
export function createSellerApp(deps: SellerAppDeps): Express {
  const { payTo, sellerName, publicUrl, ai } = deps;
  const now = deps.now ?? Date.now;
  const newsUrl = (slug: string) => `${publicUrl}/news/${slug}`;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  // The JSON parser runs before payment, so malformed or oversized bodies are never charged.
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/v1/catalog', (_req, res) => {
    res.json(catalog({ name: sellerName, payTo }));
  });
  app.get('/news/:slug', (req, res) => {
    const article = articleBySlug(req.params['slug'] ?? '');
    if (!article) throw new HttpError(404, 'not_found', 'Article not found');
    res.type('html').send(newsPage(article, utcDate(now())));
  });

  app.use(paymentMiddleware(routesConfig(payTo), deps.resourceServer));

  app.get('/v1/quote', (req, res) => {
    const { symbol } = parse(quoteQuery, req.query);
    const nowMs = now();
    const date = utcDate(nowMs);
    res.json({
      ...quoteAt(symbol, nowMs),
      relatedNews: articlesFor(QUOTE_ROWS[symbol].topic)
        .slice(0, RELATED_NEWS_MAX)
        .map((article) => ({ title: article.title, url: newsUrl(article.slug), publishedAt: date })),
      source: DEMO_SOURCE,
      simulated: true,
    });
  });

  app.post(
    '/v1/summarize',
    handler(async (req, res) => {
      const body = parse(summarizeBody, req.body);
      const article = newsroomArticle(publicUrl, body.url);
      if (!article) {
        throw new HttpError(
          400,
          'unsupported_url',
          `Only pages from this seller's newsroom (${new URL(publicUrl).origin}/news/…) can be summarized.`,
        );
      }
      const maxWords = body.maxWords ?? SUMMARY_WORDS.default;
      const summary = await withAi(() => ai.summarize({ title: article.title, text: article.body, maxWords }));
      res.json({
        url: newsUrl(article.slug),
        title: article.title,
        summary,
        words: wordCount(summary),
        source: DEMO_SOURCE,
        simulated: true,
      });
    }),
  );

  app.post(
    '/v1/translate',
    handler(async (req, res) => {
      const body = parse(translateBody, req.body);
      const translatedText = await withAi(() => ai.translate({ text: body.text, targetLanguage: body.targetLanguage }));
      res.json({ targetLanguage: body.targetLanguage, translatedText, characters: body.text.length });
    }),
  );

  app.get('/v1/news/premium', (req, res) => {
    const { topic } = parse(premiumQuery, req.query);
    const date = utcDate(now());
    res.json({
      topic,
      articles: articlesFor(topic).map((article) => ({
        title: article.title,
        url: newsUrl(article.slug),
        publishedAt: date,
        body: article.body,
      })),
      analystNote: ANALYST_NOTES[topic],
      source: DEMO_SOURCE,
      simulated: true,
    });
  });

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'not_found', 'Not found'));
  });
  app.use(errorHandler());
  return app;
}
