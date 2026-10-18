/** The files of the key panel (design spec §10.5), built in the browser from the creation response. */
export function envFile(name: string, seed: string): string {
  return `# .env for ${name}\nAGENT_PRIVATE_KEY=${seed}\n`;
}

export function jwkFile(jwk: { kty: string; crv: string; x: string; d: string }): string {
  return `${JSON.stringify(jwk, null, 2)}\n`;
}

/** The agent-name rule, shared by the browser forms and the server route (browser-safe module). */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const AGENT_NAME_MESSAGE = 'Use lowercase letters, digits and dashes.';

export function agentNameError(name: string): string | undefined {
  return AGENT_NAME_PATTERN.test(name) ? undefined : AGENT_NAME_MESSAGE;
}
