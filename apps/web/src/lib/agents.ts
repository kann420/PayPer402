/**
 * Agent keys (design spec §4.4): the web server generates each key, registers only its public half
 * with the facilitator, returns the private key once, and keeps the seed in the session cookie.
 */
import 'server-only';
import { exportPrivateKeyJwk, exportPrivateKeyRaw, generateAgentKey, type Ed25519PrivateJwk } from '@payper402/scheme-paypal';
import type { Agent, OperatorApi } from './facilitator';
import { withAgentKey, type Session } from './session';


export interface CreatedAgent {
  agent: Agent;
  key: { seed: string; jwk: Ed25519PrivateJwk; fingerprint: string };
  session: Session;
}

export async function createAgent(api: OperatorApi, session: Session, name: string): Promise<CreatedAgent> {
  const key = generateAgentKey();
  const { agent } = await api.createAgent({ name, publicKeyX: key.publicKeyX });
  const seed = exportPrivateKeyRaw(key.privateKey);
  return {
    agent,
    key: { seed, jwk: exportPrivateKeyJwk(key.privateKey), fingerprint: agent.keyFingerprint },
    session: withAgentKey(session, { id: agent.id, name: agent.name, seed }),
  };
}
