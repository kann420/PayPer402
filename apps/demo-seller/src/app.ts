import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import type { z } from 'zod';
import type { SellerAi } from './ai';
import {
  DEMO_SOURCE,
  HOTELS,
  HOTEL_IDS,
  PLACES,
  SEASON_NOTE,
  inOrNear,
  inSeason,
  priceIndex,
  ratesFor,
  stayNights,
  walkBetween,
  wordCount,
} from './data/kyoto';
import { SUMMARY_MAX_WORDS, catalog, forecastQuery, ratesQuery, reviewBody, routesConfig, searchQuery, walkQuery } from './services';

export interface SellerAppDeps {
  /** The seller id at the facilitator: the `payTo` of every route. */
  payTo: string;
  sellerName: string;
  /** External base URL, without a trailing slash. Reserved for links; no route uses it yet. */
  publicUrl: string;
  /** An initialized resource server with the PayPal scheme registered. */
  resourceServer: x402ResourceServer;
  ai: SellerAi;
}

/** A body limit of 32 KB, checked before payment (design spec §3.4). */
export const BODY_LIMIT = '32kb';
const SEARCH_MAX_RESULTS = 6;
const PRICE_NOTE = 'Indicative off-season price. Check Room Rates for your dates.';
const FORECAST_OUTLOOK = 'Rates usually stay near the peak through April 5 and ease after April 10.';
const FORECAST_NOTE =
  'Our view: demand for the cherry blossom weeks is strong and the best-placed hotels fill early. ' +
  'Prices tend to hold until the blossoms fade, so a lower rate later is unlikely. ' +
  'Compare the actual nightly rates of a few hotels before you decide.';

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
    throw new HttpError(503, 'ai_unavailable', 'The review summary service is unavailable; you were not charged');
  }
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
  const { payTo, sellerName, ai } = deps;

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

  app.use(paymentMiddleware(routesConfig(payTo), deps.resourceServer));

  app.get('/v1/hotels/search', (req, res) => {
    const query = parse(searchQuery, req.query);
    const hotels = HOTEL_IDS.map((id) => HOTELS[id])
      .filter((hotel) => query.area === undefined || inOrNear(hotel.id, query.area))
      .filter((hotel) => query.maxPricePerNight === undefined || hotel.base <= query.maxPricePerNight)
      .sort((a, b) => b.rating - a.rating || (a.id < b.id ? -1 : 1))
      .slice(0, SEARCH_MAX_RESULTS)
      .map((hotel) => ({
        id: hotel.id,
        name: hotel.name,
        area: hotel.area,
        stars: hotel.stars,
        style: hotel.style,
        tags: hotel.tags,
        rating: hotel.rating,
        reviewCount: hotel.reviews.length,
        fromPricePerNight: hotel.base,
        priceNote: PRICE_NOTE,
      }));
    res.json({
      city: query.city,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      hotels,
      ...(stayNights(query.checkIn, query.checkOut).some(inSeason) ? { seasonNote: SEASON_NOTE } : {}),
      source: DEMO_SOURCE,
      simulated: true,
    });
  });

  app.get('/v1/hotels/rates', (req, res) => {
    const query = parse(ratesQuery, req.query);
    res.json({ ...ratesFor(query.hotelId, query.checkIn, query.checkOut), source: DEMO_SOURCE, simulated: true });
  });

  app.post(
    '/v1/hotels/reviews/summary',
    handler(async (req, res) => {
      const body = parse(reviewBody, req.body);
      const hotel = HOTELS[body.hotelId];
      const summary = await withAi(() =>
        ai.summarizeReviews({
          hotelName: hotel.name,
          reviews: hotel.reviews,
          ...(body.focus === undefined ? {} : { focus: body.focus }),
          maxWords: SUMMARY_MAX_WORDS,
        }),
      );
      res.json({
        hotelId: hotel.id,
        name: hotel.name,
        rating: hotel.rating,
        reviewCount: hotel.reviews.length,
        focus: body.focus ?? null,
        summary,
        words: wordCount(summary),
        source: DEMO_SOURCE,
        simulated: true,
      });
    }),
  );

  app.get('/v1/places/walk', (req, res) => {
    const query = parse(walkQuery, req.query);
    res.json({
      hotelId: query.hotelId,
      hotelName: HOTELS[query.hotelId].name,
      place: query.place,
      placeName: PLACES[query.place].name,
      ...walkBetween(query.hotelId, query.place),
      source: DEMO_SOURCE,
      simulated: true,
    });
  });

  app.get('/v1/hotels/forecast', (req, res) => {
    const query = parse(forecastQuery, req.query);
    res.json({
      city: query.city,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      outlook: FORECAST_OUTLOOK,
      dailyIndex: stayNights(query.checkIn, query.checkOut).map(priceIndex),
      analystNote: FORECAST_NOTE,
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
