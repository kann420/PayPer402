/** The `PayPer402-Agent` authentication scheme (operator-cli.md §4.2, §4.3). */
import type { RequestHandler, Response } from 'express';
import { parseAgentAuthorization, verifyAgentRequestSignature } from '@payper402/scheme-paypal';
import type { Db } from './db/connection';
import type { AgentRow } from './db/rows';
import { HttpError } from './http';
import type { Logger } from './logger';

/** How far `iat` may be from the server's clock, in seconds. */
export const AGENT_REQUEST_WINDOW_SECONDS = 120;

const MESSAGE = 'Missing or invalid agent signature';

/**
 * Verifies the agent's signature in order: the header format, the `iat` window, the agent, then
 * the signature over the request's own method and full path. Every failure answers the same 401.
 * Logs carry the request id and the outcome, never the header.
 */
export function agentAuth(db: Db, clock: () => number, logger: Logger): RequestHandler {
  const lookup = db.prepare('SELECT * FROM agents WHERE kid = ?');
  return (req, res, next) => {
    const requestId = String(res.locals['requestId'] ?? '');
    const refuse = (reason: string) => {
      logger.debug('Agent request refused', { requestId, reason });
      next(new HttpError(401, 'unauthorized', MESSAGE));
    };
    const header = parseAgentAuthorization(req.get('authorization'));
    if (!header) return refuse('bad_header');
    if (Math.abs(clock() - header.iat) > AGENT_REQUEST_WINDOW_SECONDS) return refuse('stale');
    const agent = lookup.get(header.kid) as AgentRow | undefined;
    if (!agent) return refuse('unknown_agent');
    // Mounted under `/v1/agent`: the signed path is the mount plus the rest, without the query.
    const valid = verifyAgentRequestSignature({
      publicKeyX: agent.public_key_x,
      kid: header.kid,
      iat: header.iat,
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      sig: header.sig,
    });
    if (!valid) return refuse('bad_signature');
    res.locals['agent'] = agent;
    logger.debug('Agent request accepted', { requestId });
    next();
  };
}

/** The authenticated agent of this request. Only valid behind `agentAuth`. */
export function agentOf(res: Response): AgentRow {
  const agent = res.locals['agent'] as AgentRow | undefined;
  if (!agent) throw new HttpError(401, 'unauthorized', MESSAGE);
  return agent;
}
