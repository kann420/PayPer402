/**
 * The demo seller's catalog (design spec §8.5): service names and endpoints for paid calls,
 * cached for 60 seconds. A path missing from the catalog shows as its own path.
 */
import type { Catalog } from '@payper402/agent';

export type CatalogLoader = () => Promise<Catalog>;

export class CatalogCache {
  private value: { catalog: Catalog; at: number } | undefined;
  private inflight: Promise<Catalog | undefined> | undefined;
  private readonly load: CatalogLoader;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(load: CatalogLoader, options: { ttlMs?: number; now?: () => number } = {}) {
    this.load = load;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** The catalog, or undefined when the seller cannot be reached and nothing is cached. */
  async get(): Promise<Catalog | undefined> {
    if (this.value !== undefined && this.now() - this.value.at < this.ttlMs) return this.value.catalog;
    this.inflight ??= this.load()
      .then((catalog) => {
        this.value = { catalog, at: this.now() };
        return catalog;
      })
      .catch(() => this.value?.catalog)
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}

export interface ServiceLabel {
  serviceId: string | undefined;
  service: string;
  method: string | undefined;
  /** `<METHOD> <path with query>`, or the bare path when it is not in the catalog. */
  endpoint: string;
}

/** Resolves a paid call's `path` (with its query) against the catalog. */
export function serviceFor(catalog: Catalog | undefined, pathWithQuery: string): ServiceLabel {
  const path = pathWithQuery.split('?')[0] ?? pathWithQuery;
  const service = catalog?.services.find((s) => s.path === path);
  if (service === undefined) return { serviceId: undefined, service: path, method: undefined, endpoint: pathWithQuery };
  return { serviceId: service.id, service: service.name, method: service.method, endpoint: `${service.method} ${pathWithQuery}` };
}
