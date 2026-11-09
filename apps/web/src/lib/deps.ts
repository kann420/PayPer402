/**
 * The dependencies of the route handlers. Route files wire the real ones (`serverDeps`); tests
 * build their own with `createDeps`.
 */
import 'server-only';
import { fetchCatalog } from '@payper402/agent';
import { CatalogCache } from './catalog';
import { required, webConfig, type WebConfig } from './config';
import { FacilitatorClient } from './facilitator';
import { DAY, HOUR, MINUTE, SlidingWindow } from './limits';

export interface Limits {
  operatorsPerClient: SlidingWindow;
  operatorsAll: SlidingWindow;
  runsPerOperator: SlidingWindow;
  runsAll: SlidingWindow;
  aiPerSession: SlidingWindow;
  aiAll: SlidingWindow;
  probesPerClient: SlidingWindow;
  claimsPerOperator: SlidingWindow;
}

export interface WebDeps {
  config: WebConfig;
  facilitator: FacilitatorClient;
  catalog: CatalogCache;
  limits: Limits;
  fetch: typeof fetch;
  log: (line: string) => void;
}

export function createLimits(config: WebConfig, now: () => number = Date.now): Limits {
  const l = config.limits;
  return {
    operatorsPerClient: new SlidingWindow(l.operatorsPerHour, HOUR, now),
    operatorsAll: new SlidingWindow(l.operatorsPerDay, DAY, now),
    runsPerOperator: new SlidingWindow(l.runsPerDay, DAY, now),
    runsAll: new SlidingWindow(l.runsPerHour, HOUR, now),
    aiPerSession: new SlidingWindow(l.aiTurnsPerHour, HOUR, now),
    aiAll: new SlidingWindow(l.aiTurnsPerDay, DAY, now),
    probesPerClient: new SlidingWindow(30, MINUTE, now),
    claimsPerOperator: new SlidingWindow(l.claimsPerHour, HOUR, now),
  };
}

export function createDeps(config: WebConfig, options: { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void } = {}): WebDeps {
  const fetchFn = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.warn(line));
  return {
    config,
    facilitator: new FacilitatorClient({ baseUrl: config.facilitatorUrl, fetch: fetchFn, log }),
    catalog: new CatalogCache(() => fetchCatalog(config.sellerUrl, fetchFn), options.now === undefined ? {} : { now: options.now }),
    limits: createLimits(config, options.now),
    fetch: fetchFn,
    log,
  };
}

const GLOBAL = globalThis as unknown as { __pp402Deps?: WebDeps };

/** The process's dependencies, built on first use (shared across route modules). */
export function serverDeps(): WebDeps {
  GLOBAL.__pp402Deps ??= createDeps(webConfig());
  return GLOBAL.__pp402Deps;
}

/** The session key, or a 503 through `WebConfigError` when `WEB_SESSION_SECRET` is unset. */
export function sessionKey(deps: WebDeps): Buffer {
  return required(deps.config.sessionSecret, 'WEB_SESSION_SECRET');
}
