/** Server-side loaders for the dashboard pages (design spec §11.3). */
import 'server-only';
import type { OperatorApi, SellerApi } from './facilitator';
import { loadCalls, windowStart } from './rows';
import { nowSeconds } from './time';

/** The operator's paid calls of the last 30 days, up to 5,000 (optionally one agent's). */
export function loadOperatorCalls(api: OperatorApi, agentId?: string) {
  return loadCalls(
    async (query) => (await api.commitments({ ...query, ...(agentId === undefined ? {} : { agentId }) })).commitments,
    { since: windowStart(nowSeconds()) },
  );
}

/** The seller's paid calls of the last 30 days, up to 5,000. */
export function loadSellerCalls(api: SellerApi) {
  return loadCalls(async (query) => (await api.commitments(query)).commitments, { since: windowStart(nowSeconds()) });
}
