import { describe, expect, it } from 'vitest';
import {
  AGENT_AUTH_SCHEME,
  AGENT_REQUEST_DOMAIN,
  agentRequestMessage,
  parseAgentAuthorization,
  signAgentRequest,
  verifyAgentRequestSignature,
} from './agent-request';
import { buildCommitment, signCommitment } from './commitment';
import { SIGNATURE_DOMAIN } from './constants';
import { generateAgentKey } from './keys';

const key = generateAgentKey();
const request = { kid: key.kid, iat: 1_760_500_000, method: 'GET', path: '/v1/agent/status' };
const sign = (overrides: Partial<typeof request> = {}) => signAgentRequest({ ...request, ...overrides, privateKey: key.privateKey });
const parse = (header: string) => {
  const parsed = parseAgentAuthorization(header);
  if (!parsed) throw new Error('expected a parsable header');
  return parsed;
};

describe('agent request signatures', () => {
  it('builds the domain-prefixed canonical message with an upper-case method', () => {
    expect(agentRequestMessage({ ...request, method: 'get' })).toBe(
      `payper402-agent-request:v1\n{"iat":1760500000,"kid":"${key.kid}","method":"GET","path":"/v1/agent/status"}`,
    );
  });

  it('round-trips: sign, parse, verify', () => {
    const header = sign();
    expect(header.startsWith(`${AGENT_AUTH_SCHEME} ${key.kid}.1760500000.`)).toBe(true);
    const parsed = parse(header);
    expect(parsed).toMatchObject({ kid: key.kid, iat: 1_760_500_000 });
    expect(parsed.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: key.publicKeyX, sig: parsed.sig })).toBe(true);
  });

  it('breaks when any signed field, the key or the signature changes', () => {
    const { sig } = parse(sign());
    const verifies = (overrides: Partial<typeof request> & { publicKeyX?: string; sig?: string }) =>
      verifyAgentRequestSignature({ ...request, publicKeyX: key.publicKeyX, sig, ...overrides });
    expect(verifies({ kid: generateAgentKey().kid })).toBe(false);
    expect(verifies({ iat: request.iat + 1 })).toBe(false);
    expect(verifies({ method: 'POST' })).toBe(false);
    expect(verifies({ path: '/v1/agent/other' })).toBe(false);
    expect(verifies({ publicKeyX: generateAgentKey().publicKeyX })).toBe(false);
    expect(verifies({ sig: sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA') })).toBe(false);
  });

  it('never throws on malformed input', () => {
    const { sig } = parse(sign());
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: 'not-a-key', sig })).toBe(false);
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: key.publicKeyX, sig: 'short' })).toBe(false);
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: '', sig: '' })).toBe(false);
  });

  it('accepts the method in either case', () => {
    const { sig } = parse(sign({ method: 'get' }));
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: key.publicKeyX, sig })).toBe(true);
  });

  it('rejects headers that do not match the exact format', () => {
    const header = sign();
    const [, rest] = header.split(' ') as [string, string];
    const [kid, iat, sig] = rest.split('.') as [string, string, string];
    expect(parseAgentAuthorization(undefined)).toBeUndefined();
    expect(parseAgentAuthorization(header)).toBeDefined();
    expect(parseAgentAuthorization(`Bearer ${rest}`)).toBeUndefined();
    expect(parseAgentAuthorization(`payper402-agent ${rest}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME}  ${rest}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${header} `)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.${iat}.${sig}=`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}=.${iat}.${sig}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.${iat}.${sig.slice(1)}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid.slice(1)}.${iat}.${sig}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.0${iat}.${sig}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.-${iat}.${sig}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.1234567890123.${sig}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.${iat}`)).toBeUndefined();
    expect(parseAgentAuthorization(`${AGENT_AUTH_SCHEME} ${kid}.0.${sig}`)).toMatchObject({ iat: 0 });
  });

  it('keeps the request domain apart from the commitment domain', () => {
    expect(AGENT_REQUEST_DOMAIN.startsWith(SIGNATURE_DOMAIN)).toBe(false);
    expect(SIGNATURE_DOMAIN.startsWith(AGENT_REQUEST_DOMAIN)).toBe(false);
  });

  it('never accepts a commitment signature as a request signature, or the reverse', () => {
    const commitment = buildCommitment({
      kid: key.kid,
      network: 'paypal:sandbox',
      asset: 'USD',
      payTo: 'seller_test',
      maxAmount: '5',
      iat: request.iat,
      exp: request.iat + 120,
    });
    const commitmentSig = signCommitment(commitment, key.privateKey);
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: key.publicKeyX, sig: commitmentSig })).toBe(false);
    const requestSig = parse(sign()).sig;
    expect(verifyAgentRequestSignature({ ...request, publicKeyX: key.publicKeyX, sig: requestSig })).toBe(true);
    // The request signature does not verify over any commitment of this key either.
    expect(signCommitment(commitment, key.privateKey)).not.toBe(requestSig);
  });
});
