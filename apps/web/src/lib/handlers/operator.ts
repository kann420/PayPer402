/** The `/api/operator/**` routes (design spec §7). Each proxies one facilitator call. */
import 'server-only';
import { z } from 'zod';
import { createAgent } from '../agents';
import { AGENT_NAME_MESSAGE, AGENT_NAME_PATTERN } from '../key-files';
import { sessionKey, type WebDeps } from '../deps';
import { MAX_CAP_CENTS } from '../caps-form';
import { checkOrigin, errorResponse, json, readBody, requireOperator, withCookie } from './common';

const emptyBody = z.union([z.undefined(), z.strictObject({})]);
const cents = z.number().int().min(0).max(MAX_CAP_CENTS);
const capsBody = z.strictObject({ perCall: cents, daily: cents, unsettled: cents, total: cents.nullable() });
const agentBody = z.strictObject({ name: z.string().regex(AGENT_NAME_PATTERN, AGENT_NAME_MESSAGE) });
const patchBody = z.strictObject({ status: z.enum(['active', 'paused']) });


/** Wraps a state-changing operator route: origin check, operator session, error mapping. */
function operatorRoute(fn: (args: { deps: WebDeps; request: Request; session: ReturnType<typeof requireOperator>; key: Buffer }) => Promise<Response>) {
  return (deps: WebDeps): ((request: Request) => Promise<Response>) =>
    async (request) => {
      try {
        checkOrigin(request, deps.config.publicOrigin);
        const key = sessionKey(deps);
        const session = requireOperator(request, key);
        return await fn({ deps, request, session, key });
      } catch (error) {
        return errorResponse(error, deps.log);
      }
    };
}

/** `POST /api/operator/wallet/link`. */
export const createLinkHandler = operatorRoute(async ({ deps, request, session }) => {
  await readBody(request, emptyBody);
  return json(await deps.facilitator.operator(session.operator.key).link());
});

/** `POST /api/operator/wallet/refresh`. */
export const createRefreshHandler = operatorRoute(async ({ deps, request, session }) => {
  await readBody(request, emptyBody);
  return json(await deps.facilitator.operator(session.operator.key).refresh());
});

/** `POST /api/operator/wallet/unlink`; 409 bodies (with the `wallet`) pass through. */
export const createUnlinkHandler = operatorRoute(async ({ deps, request, session }) => {
  await readBody(request, emptyBody);
  return json(await deps.facilitator.operator(session.operator.key).unlink());
});

/** `PUT /api/operator/caps`: always all four fields; `total: null` means no total limit. */
export const createCapsHandler = operatorRoute(async ({ deps, request, session }) => {
  const body = await readBody(request, capsBody);
  return json(await deps.facilitator.operator(session.operator.key).putCaps(body));
});

/** `POST /api/operator/settlements`: "Charge now". */
export const createSettleHandler = operatorRoute(async ({ deps, request, session }) => {
  await readBody(request, emptyBody);
  return json(await deps.facilitator.operator(session.operator.key).settle(), { status: 201 });
});

/** `POST /api/operator/agents` (design spec §4.4): one of the two routes that write the cookie. */
export const createAgentsHandler = operatorRoute(async ({ deps, request, session, key }) => {
  const body = await readBody(request, agentBody);
  const created = await createAgent(deps.facilitator.operator(session.operator.key), session, body.name);
  return withCookie(json({ agent: created.agent, key: created.key }, { status: 201 }), created.session, key, deps.config.secure);
});

/** `PATCH /api/operator/agents/:id` with `{ status }`. */
export function createPatchAgentHandler(deps: WebDeps): (request: Request, id: string) => Promise<Response> {
  return (request, id) =>
    operatorRoute(async ({ deps: d, request: r, session }) => {
      const body = await readBody(r, patchBody);
      return json(await d.facilitator.operator(session.operator.key).patchAgent(id, body));
    })(deps)(request);
}

