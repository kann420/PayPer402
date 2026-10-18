/** `GET /api/seller/probe/:serviceId` (design spec §7, §10.11). */
import 'server-only';
import { sessionKey, type WebDeps } from '../deps';
import { clientKey } from '../limits';
import { probe } from '../probe';
import { errorResponse, json, requireSession, RouteError } from './common';

export function createProbeHandler(deps: WebDeps): (request: Request, serviceId: string) => Promise<Response> {
  return async (request, serviceId) => {
    try {
      requireSession(request, sessionKey(deps));
      const client = clientKey(request, deps.config.trustProxy);
      if (!deps.limits.probesPerClient.allows(client)) throw new RouteError(429, 'probe_limit', 'Too many test requests. Try again in a minute.');
      deps.limits.probesPerClient.hit(client);
      const catalog = await deps.catalog.get();
      if (catalog === undefined) throw new RouteError(503, 'seller_unavailable', "The seller console isn't available right now.");
      let result;
      try {
        result = await probe({ catalog, serviceId, sellerUrl: deps.config.sellerUrl, fetch: deps.fetch });
      } catch {
        throw new RouteError(502, 'upstream_error', 'The seller API did not answer.');
      }
      if (result === undefined) throw new RouteError(404, 'not_found', 'There is no such endpoint.');
      return json(result);
    } catch (error) {
      return errorResponse(error, deps.log);
    }
  };
}
