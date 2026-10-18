/** `POST /api/session` (design spec §4.2): the demo picker, the switcher and "Start over". */
import 'server-only';
import { z } from 'zod';
import { sessionKey, type WebDeps } from '../deps';
import { isFacilitatorError } from '../facilitator';
import { clientKey, SlidingWindow } from '../limits';
import { newSession, readSession, type Session } from '../session';
import { checkOrigin, errorResponse, json, readBody, RouteError, withCookie } from './common';

const bodySchema = z.strictObject({ role: z.enum(['operator', 'seller']), startOver: z.boolean().optional() });

export const DEMO_LIMIT_MESSAGE = 'Too many new demo accounts right now. Try again in a few minutes.';

/** Where an operator lands: the console when the wallet is linked or was, onboarding otherwise. */
export function nextForWallet(status: string): '/app' | '/app/onboarding/link' {
  return status === 'active' || status === 'unlinking' || status === 'stopped_by_payer' ? '/app' : '/app/onboarding/link';
}

export function createSessionHandler(deps: WebDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      checkOrigin(request, deps.config.publicOrigin);
      const key = sessionKey(deps);
      const body = await readBody(request, bodySchema);
      let session: Session = readSession(request, key) ?? newSession();

      if (body.role === 'seller') {
        return withCookie(json({ next: '/seller' }), session, key, deps.config.secure);
      }

      if (session.operator !== undefined && body.startOver !== true) {
        try {
          const view = await deps.facilitator.operator(session.operator.key).get();
          return withCookie(json({ next: nextForWallet(view.wallet.status) }), session, key, deps.config.secure);
        } catch (error) {
          // 401: the key was revoked or the database reset; create a new operator below.
          if (!(isFacilitatorError(error) && error.code === 'session_ended')) throw error;
        }
      }

      const limits = deps.limits;
      const client = clientKey(request, deps.config.trustProxy);
      if (!SlidingWindow.take([[limits.operatorsPerClient, client], [limits.operatorsAll, 'all']])) {
        throw new RouteError(429, 'demo_limit', DEMO_LIMIT_MESSAGE);
      }
      const adminKey = deps.config.adminKey;
      if (adminKey === undefined) throw new RouteError(503, 'not_configured', 'The operator demo is not configured.');
      const created = await deps.facilitator.admin(adminKey).createDemoOperator();
      session = {
        ...session,
        operator: { id: created.operator.id, key: created.apiKey, createdAt: Math.floor(Date.now() / 1000) },
        agents: [],
      };
      return withCookie(json({ next: '/app/onboarding/link' }), session, key, deps.config.secure);
    } catch (error) {
      return errorResponse(error, deps.log);
    }
  };
}
