import type { PaymentOption, RouteConfig } from '@x402/core/http';
import { ASSET, PAYPAL_SANDBOX_NETWORK, SCHEME } from '@payper402/scheme-paypal';
import { z } from 'zod';

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

export const SYMBOLS = ['KC', 'CC', 'SB', 'CT'] as const;
export type CommoditySymbol = (typeof SYMBOLS)[number];
export const TOPICS = ['coffee', 'cocoa', 'sugar', 'cotton'] as const;
export type Topic = (typeof TOPICS)[number];

export const SUMMARIZE_URL_MAX = 300;
export const SUMMARY_WORDS = { min: 30, max: 300, default: 120 } as const;
export const TRANSLATE_TEXT_MAX = 4000;
export const TARGET_LANGUAGE = /^[A-Za-z][A-Za-z -]{0,31}$/;

/** The single source of truth for the paid services (design spec §3.2). */
export const SERVICES: readonly ServiceDef[] = [
  {
    id: 'quote',
    name: 'Market Quote API',
    description:
      "Latest futures price for a soft commodity (KC coffee, CC cocoa, SB sugar, CT cotton), with links to today's related news pages.",
    method: 'GET',
    path: '/v1/quote',
    priceCents: 2,
    params: { symbol: { type: 'string', description: 'Commodity symbol', enum: [...SYMBOLS] } },
    required: ['symbol'],
  },
  {
    id: 'summarize',
    name: 'Page Summary API',
    description: 'Reads a news page from the Acme Data newsroom and returns a short summary.',
    method: 'POST',
    path: '/v1/summarize',
    priceCents: 5,
    params: {
      url: { type: 'string', description: 'URL of a newsroom page', maxLength: SUMMARIZE_URL_MAX },
      maxWords: {
        type: 'integer',
        description: `Longest summary in words (default ${SUMMARY_WORDS.default})`,
        minimum: SUMMARY_WORDS.min,
        maximum: SUMMARY_WORDS.max,
      },
    },
    required: ['url'],
  },
  {
    id: 'translate',
    name: 'Translate API',
    description: 'Translates text into another language.',
    method: 'POST',
    path: '/v1/translate',
    priceCents: 1,
    params: {
      text: { type: 'string', description: 'Text to translate', maxLength: TRANSLATE_TEXT_MAX },
      targetLanguage: { type: 'string', description: 'Language name or code, for example "Vietnamese" or "vi"', maxLength: 32 },
    },
    required: ['text', 'targetLanguage'],
  },
  {
    id: 'premium_news',
    name: 'Premium News API',
    description: 'Full-length coverage of a commodity topic, with analyst commentary.',
    method: 'GET',
    path: '/v1/news/premium',
    priceCents: 25,
    params: { topic: { type: 'string', description: 'Commodity topic', enum: [...TOPICS] } },
    required: ['topic'],
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
export const quoteQuery = z.strictObject({ symbol: z.enum(SYMBOLS) });

export const summarizeBody = z.strictObject({
  url: z.string().min(1).max(SUMMARIZE_URL_MAX),
  maxWords: z.number().int().min(SUMMARY_WORDS.min).max(SUMMARY_WORDS.max).optional(),
});

export const translateBody = z.strictObject({
  text: z.string().min(1).max(TRANSLATE_TEXT_MAX),
  targetLanguage: z.string().regex(TARGET_LANGUAGE, 'must be a language name or code (letters, spaces and hyphens)'),
});

export const premiumQuery = z.strictObject({ topic: z.enum(TOPICS) });
