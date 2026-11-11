import type { PaymentOption, RouteConfig } from '@x402/core/http';
import { ASSET, PAYPAL_SANDBOX_NETWORK, SCHEME } from '@payper402/scheme-paypal';
import { z } from 'zod';
import { AREAS, CITIES, HOTEL_IDS, MAX_NIGHTS, PLACE_IDS, isRealDate, nightsBetween } from './data/kyoto';

/** A catalog param: a string or an integer, with optional bounds (design spec §3.3). */
export type ParamSpec =
  | { type: 'string'; description: string; maxLength?: number; enum?: string[] }
  | { type: 'integer'; description: string; minimum?: number; maximum?: number };

export interface ServiceDef {
  id: string;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  path: string;
  priceCents: number;
  params: Record<string, ParamSpec>;
  required: string[];
}

export const FOCUS_MAX = 80;
export const SUMMARY_MAX_WORDS = 90;
export const PRICE_LIMIT = { min: 20, max: 2000 };

const CHECK_IN: ParamSpec = { type: 'string', description: 'Check-in date, YYYY-MM-DD' };
const CHECK_OUT: ParamSpec = { type: 'string', description: `Check-out date, YYYY-MM-DD (after check-in, at most ${MAX_NIGHTS} nights)` };
const HOTEL_ID: ParamSpec = { type: 'string', description: 'Hotel id from Hotel Search', enum: [...HOTEL_IDS] };
const CITY: ParamSpec = { type: 'string', description: 'City', enum: [...CITIES] };

/** The single source of truth for the paid services (design spec §3.2). */
export const SERVICES: readonly ServiceDef[] = [
  {
    id: 'hotel_search',
    name: 'Hotel Search API',
    description:
      'Search hotels in a city for your dates. Returns candidates with an indicative off-season price; check Room Rates for the real price of your nights.',
    method: 'GET',
    path: '/v1/hotels/search',
    priceCents: 2,
    params: {
      city: CITY,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      area: { type: 'string', description: 'Only hotels in or within a 15-minute walk of this area (optional)', enum: [...AREAS] },
      maxPricePerNight: {
        type: 'integer',
        description: 'Highest indicative price per night in USD (optional)',
        minimum: PRICE_LIMIT.min,
        maximum: PRICE_LIMIT.max,
      },
    },
    required: ['city', 'checkIn', 'checkOut'],
  },
  {
    id: 'hotel_rates',
    name: 'Room Rates API',
    description: 'Nightly rates and rooms left for one hotel and your dates, with the cancellation policy.',
    method: 'GET',
    path: '/v1/hotels/rates',
    priceCents: 1,
    params: { hotelId: HOTEL_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT },
    required: ['hotelId', 'checkIn', 'checkOut'],
  },
  {
    id: 'review_summary',
    name: 'Review Summary API',
    description: "A short summary of a hotel's guest reviews, optionally focused on one topic such as noise or location.",
    method: 'POST',
    path: '/v1/hotels/reviews/summary',
    priceCents: 5,
    params: {
      hotelId: HOTEL_ID,
      focus: { type: 'string', description: 'A topic to focus on, for example "noise at night" (optional)', maxLength: FOCUS_MAX },
    },
    required: ['hotelId'],
  },
  {
    id: 'walking_time',
    name: 'Walking Time API',
    description: 'Walking time and distance from a hotel to a landmark.',
    method: 'GET',
    path: '/v1/places/walk',
    priceCents: 1,
    params: {
      hotelId: HOTEL_ID,
      place: { type: 'string', description: 'Landmark id', enum: [...PLACE_IDS] },
    },
    required: ['hotelId', 'place'],
  },
  {
    id: 'price_forecast',
    name: 'Price Forecast API (premium)',
    description: 'Analyst forecast of how hotel prices in the city move around your dates.',
    method: 'GET',
    path: '/v1/hotels/forecast',
    priceCents: 25,
    params: { city: CITY, checkIn: CHECK_IN, checkOut: CHECK_OUT },
    required: ['city', 'checkIn', 'checkOut'],
  },
];

export interface Catalog {
  seller: { name: string; payTo: string };
  scheme: string;
  network: string;
  asset: string;
  services: ServiceDef[];
}

/** The free catalog (design spec §3.3), derived from `SERVICES`. */
export function catalog(seller: { name: string; payTo: string }): Catalog {
  return {
    seller: { name: seller.name, payTo: seller.payTo },
    scheme: SCHEME,
    network: PAYPAL_SANDBOX_NETWORK,
    asset: ASSET,
    services: SERVICES.map((s) => ({ ...s, params: structuredClone(s.params), required: [...s.required] })),
  };
}

/** The `@x402/express` route config, derived from `SERVICES`, so prices cannot differ. */
export function routesConfig(payTo: string): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  for (const service of SERVICES) {
    const accepts: PaymentOption = {
      scheme: SCHEME,
      network: PAYPAL_SANDBOX_NETWORK,
      payTo,
      price: { asset: ASSET, amount: String(service.priceCents) },
    };
    routes[`${service.method} ${service.path}`] = {
      accepts,
      description: service.description,
      mimeType: 'application/json',
    };
  }
  return routes;
}

/** Handler-side param schemas. Payment is verified before these run (design spec §3.4). */
const date = z.string().refine(isRealDate, 'must be a real date, YYYY-MM-DD');
const hotelId = z.enum(HOTEL_IDS);
const city = z.enum(CITIES);

/** A stay: `checkOut` after `checkIn`, at most 14 nights. Runs only when both dates are real dates. */
function validStay(value: { checkIn: string; checkOut: string }, ctx: z.RefinementCtx): void {
  if (!isRealDate(value.checkIn) || !isRealDate(value.checkOut)) return;
  const nights = nightsBetween(value.checkIn, value.checkOut);
  if (nights < 1) ctx.addIssue({ code: 'custom', path: ['checkOut'], message: 'must be after checkIn' });
  else if (nights > MAX_NIGHTS) ctx.addIssue({ code: 'custom', path: ['checkOut'], message: `must be at most ${MAX_NIGHTS} nights after checkIn` });
}

export const searchQuery = z
  .strictObject({
    city,
    checkIn: date,
    checkOut: date,
    area: z.enum(AREAS).optional(),
    maxPricePerNight: z.coerce.number().int().min(PRICE_LIMIT.min).max(PRICE_LIMIT.max).optional(),
  })
  .superRefine(validStay);

export const ratesQuery = z.strictObject({ hotelId, checkIn: date, checkOut: date }).superRefine(validStay);

export const reviewBody = z.strictObject({ hotelId, focus: z.string().min(1).max(FOCUS_MAX).optional() });

export const walkQuery = z.strictObject({ hotelId, place: z.enum(PLACE_IDS) });

export const forecastQuery = z.strictObject({ city, checkIn: date, checkOut: date }).superRefine(validStay);
