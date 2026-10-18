/** `GET /api/events?scope=operator|seller` (design spec §13). */
import 'server-only';
import { required } from '../config';
import { sessionKey, type WebDeps } from '../deps';
import { operatorRelay, SellerHub, type RelayOutcome, type Timers } from '../events-relay';
import { errorResponse, jsonError, requireScope } from './common';

const GLOBAL = globalThis as unknown as { __pp402SellerHub?: SellerHub };

/** The process's shared seller hub. */
export function sellerHub(deps: WebDeps, options: { timers?: Timers; idleCloseMs?: number } = {}): SellerHub {
  GLOBAL.__pp402SellerHub ??= new SellerHub(
    (signal) =>
      deps.fetch(`${deps.config.facilitatorUrl}/v1/events`, {
        headers: { Authorization: `Bearer ${required(deps.config.sellerKey, 'WEB_SELLER_API_KEY')}` },
        signal,
      }),
    options,
  );
  return GLOBAL.__pp402SellerHub;
}

function failure(outcome: RelayOutcome & { ok: false }, scope: 'operator' | 'seller', log: (line: string) => void): Response {
  if (outcome.status === 429) return jsonError(429, 'too_many_streams', 'Too many live connections. The page refreshes every 15 seconds instead.');
  if (outcome.status === 401) {
    if (scope === 'operator') return jsonError(401, 'session_ended', 'Your demo session ended. Start a new one.');
    log('[events] the seller key (WEB_SELLER_API_KEY) was refused with 401; check the configuration');
    return jsonError(503, 'seller_unavailable', "The seller console isn't available right now.");
  }
  return jsonError(502, 'upstream_error', 'Live updates are not available right now.');
}

export function createEventsHandler(deps: WebDeps, hub?: SellerHub) {
  return async (request: Request): Promise<Response> => {
    try {
      const { scope, session } = requireScope(request, sessionKey(deps));
      let outcome: RelayOutcome;
      if (scope === 'operator') {
        const key = session.operator?.key as string;
        outcome = await operatorRelay({
          open: (signal) => deps.fetch(`${deps.config.facilitatorUrl}/v1/events`, { headers: { Authorization: `Bearer ${key}` }, signal }),
          requestSignal: request.signal,
        });
      } else {
        outcome = await (hub ?? sellerHub(deps)).relay(request.signal);
      }
      return outcome.ok ? outcome.response : failure(outcome, scope, deps.log);
    } catch (error) {
      return errorResponse(error, deps.log);
    }
  };
}
