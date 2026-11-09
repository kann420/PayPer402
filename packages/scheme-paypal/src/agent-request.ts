/**
 * Agent-signed HTTP requests (operator CLI design spec §4.2).
 *
 * Not part of the binding: this is a PayPer402 service helper. It lives here because the
 * facilitator and the agent both depend on this package and on its `canonical` helper, and so the
 * two sides cannot drift apart. A request signature uses its own domain prefix, so it can never
 * verify as a commitment signature, or the reverse.
 */
import { sign, verify, type KeyObject } from 'node:crypto';
import { canonical } from './canonical';
import { decodeBase64UrlExact, toBase64Url } from './encoding';
import { ED25519_KEY_BYTES, publicKeyFromX } from './keys';

/** Domain prefix of every signed agent request message. */
export const AGENT_REQUEST_DOMAIN = 'payper402-agent-request:v1\n';

/** The `Authorization` scheme of an agent-signed request. */
export const AGENT_AUTH_SCHEME = 'PayPer402-Agent';

const SIGNATURE_BYTES = 64;

const AUTHORIZATION = /^PayPer402-Agent ([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,11})\.([A-Za-z0-9_-]{86})$/;

export interface AgentRequestFields {
  /** The agent's key id. */
  kid: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** The HTTP method; signed in upper case. */
  method: string;
  /** The request path without the query, for example `/v1/agent/status`. */
  path: string;
}

/** The exact message the agent signs: the domain prefix followed by the canonical fields. */
export function agentRequestMessage(input: AgentRequestFields): string {
  return AGENT_REQUEST_DOMAIN + canonical({ iat: input.iat, kid: input.kid, method: input.method.toUpperCase(), path: input.path });
}

/** Signs a request with the agent's key. Returns the full `Authorization` header value. */
export function signAgentRequest(input: AgentRequestFields & { privateKey: KeyObject }): string {
  const signature = toBase64Url(sign(null, Buffer.from(agentRequestMessage(input), 'utf8'), input.privateKey));
  return `${AGENT_AUTH_SCHEME} ${input.kid}.${input.iat}.${signature}`;
}

/** Parses an `Authorization` header of this scheme with the exact format of §4.2, or `undefined`. */
export function parseAgentAuthorization(header: string | undefined): { kid: string; iat: number; sig: string } | undefined {
  if (header === undefined) return undefined;
  const match = AUTHORIZATION.exec(header);
  if (!match) return undefined;
  const iat = Number(match[2]);
  if (!Number.isSafeInteger(iat)) return undefined;
  return { kid: match[1] as string, iat, sig: match[3] as string };
}

/** Verifies a request signature against a raw public key (`x`). Returns false, never throws. */
export function verifyAgentRequestSignature(input: AgentRequestFields & { publicKeyX: string; sig: string }): boolean {
  try {
    const sig = decodeBase64UrlExact(input.sig, SIGNATURE_BYTES);
    if (!sig || decodeBase64UrlExact(input.publicKeyX, ED25519_KEY_BYTES) === undefined) return false;
    return verify(null, Buffer.from(agentRequestMessage(input), 'utf8'), publicKeyFromX(input.publicKeyX), sig);
  } catch {
    return false;
  }
}
