import { ASSET, PAYPAL_SANDBOX_NETWORK, SCHEME, isValidCents } from '@payper402/scheme-paypal';
import { z } from 'zod';

/** Limits on an untrusted catalog (design spec §4.1). */
export const CATALOG_LIMITS = {
  services: 20,
  params: 8,
  nameChars: 60,
  descriptionChars: 300,
  stringMaxLength: 8000,
  payToChars: 128,
} as const;

export const CATALOG_TIMEOUT_MS = 10_000;

const SERVICE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const SERVICE_PATH = /^\/[A-Za-z0-9/_-]{1,100}$/;

const description = z.string().max(CATALOG_LIMITS.descriptionChars);

const stringParam = z.strictObject({
  type: z.literal('string'),
  description,
  maxLength: z.number().int().min(1).max(CATALOG_LIMITS.stringMaxLength).optional(),
  enum: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
});

const integerParam = z.strictObject({
  type: z.literal('integer'),
  description,
  minimum: z.number().int().optional(),
  maximum: z.number().int().optional(),
});

const paramSpec = z.discriminatedUnion('type', [stringParam, integerParam]);
export type ParamSpec = z.output<typeof paramSpec>;

const serviceSchema = z
  .strictObject({
    id: z.string().regex(SERVICE_ID),
    name: z.string().min(1).max(CATALOG_LIMITS.nameChars),
    description,
    method: z.enum(['GET', 'POST']),
    path: z
      .string()
      .regex(SERVICE_PATH)
      .refine((path) => !path.includes('//'), 'must not contain //'),
    priceCents: z.number().refine(isValidCents, 'must be a valid cents value'),
    params: z
      .record(z.string().regex(PARAM_NAME), paramSpec)
      .refine((params) => Object.keys(params).length <= CATALOG_LIMITS.params, `at most ${CATALOG_LIMITS.params} params`),
    required: z.array(z.string()).max(CATALOG_LIMITS.params),
  })
  .superRefine((service, ctx) => {
    for (const name of service.required) {
      if (!Object.hasOwn(service.params, name)) ctx.addIssue({ code: 'custom', path: ['required'], message: `unknown required param ${name}` });
    }
  });

export type CatalogService = z.output<typeof serviceSchema>;

export const catalogSchema = z
  .strictObject({
    seller: z.strictObject({
      name: z.string().min(1).max(CATALOG_LIMITS.nameChars),
      payTo: z.string().min(1).max(CATALOG_LIMITS.payToChars),
    }),
    scheme: z.literal(SCHEME),
    network: z.literal(PAYPAL_SANDBOX_NETWORK),
    asset: z.literal(ASSET),
    services: z.array(serviceSchema).max(CATALOG_LIMITS.services),
  })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    catalog.services.forEach((service, index) => {
      if (seen.has(service.id)) ctx.addIssue({ code: 'custom', path: ['services', index, 'id'], message: 'duplicate service id' });
      seen.add(service.id);
    });
  });

export type Catalog = z.output<typeof catalogSchema>;

/** A catalog that could not be loaded; the message names the problem without echoing the body. */
export class CatalogError extends Error {
  override readonly name = 'CatalogError';
}

/** Validates an untrusted catalog. Throws a `CatalogError` listing the issue paths. */
export function parseCatalog(value: unknown): Catalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    throw new CatalogError(`The seller catalog is invalid: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** The service URL: the catalog path on the seller's origin. Throws if the origin would differ. */
export function serviceUrl(sellerUrl: string, service: CatalogService): URL {
  const url = new URL(service.path, sellerUrl);
  if (url.origin !== new URL(sellerUrl).origin) throw new CatalogError(`Service ${service.id} is not on the seller's origin`);
  return url;
}

/** Fetches and validates `<sellerUrl>/v1/catalog` with a 10 s timeout. */
export async function fetchCatalog(sellerUrl: string, fetchFn: typeof fetch = fetch): Promise<Catalog> {
  let res: Response;
  try {
    res = await fetchFn(new URL('/v1/catalog', sellerUrl), { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  } catch {
    throw new CatalogError(`Could not reach the seller at ${new URL(sellerUrl).origin}`);
  }
  if (res.status !== 200) throw new CatalogError(`The seller catalog answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CatalogError('The seller catalog is not JSON');
  }
  const catalog = parseCatalog(body);
  for (const service of catalog.services) serviceUrl(sellerUrl, service);
  return catalog;
}

export type ParamValue = string | number;

export interface ParamIssue {
  param: string;
  message: string;
}

/**
 * Validates call params against a catalog service (design spec §4.1): unknown and missing params,
 * types (integers are safe integers), `enum`, `maxLength`, and `minimum`/`maximum`.
 */
export function validateParams(service: CatalogService, params: Record<string, unknown>): ParamIssue[] {
  const issues: ParamIssue[] = [];
  for (const name of Object.keys(params)) {
    if (!Object.hasOwn(service.params, name)) issues.push({ param: name, message: 'unknown param' });
  }
  for (const name of service.required) {
    if (!Object.hasOwn(params, name) || params[name] === undefined) issues.push({ param: name, message: 'required' });
  }
  for (const [name, spec] of Object.entries(service.params)) {
    // Own keys only: a name such as `constructor` must never resolve through the prototype.
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) continue;
    if (spec.type === 'string') {
      if (typeof value !== 'string') {
        issues.push({ param: name, message: 'must be a string' });
        continue;
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        issues.push({ param: name, message: `must be at most ${spec.maxLength} characters` });
      }
      if (spec.enum !== undefined && !spec.enum.includes(value)) {
        issues.push({ param: name, message: `must be one of ${spec.enum.join(', ')}` });
      }
    } else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        issues.push({ param: name, message: 'must be an integer' });
        continue;
      }
      if (spec.minimum !== undefined && value < spec.minimum) issues.push({ param: name, message: `must be at least ${spec.minimum}` });
      if (spec.maximum !== undefined && value > spec.maximum) issues.push({ param: name, message: `must be at most ${spec.maximum}` });
    }
  }
  return issues;
}
