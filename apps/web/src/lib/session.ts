/**
 * The session cookie (design spec §4): AES-256-GCM sealed JSON in the facilitator's sealed format,
 * `v1.<iv>.<tag>.<ciphertext>` in base64url with a 12-byte IV. Only server code reads or writes it;
 * only `POST /api/session` and `POST /api/operator/agents` set it.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const SESSION_COOKIE = 'pp402_session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const MAX_AGENT_KEYS = 5;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]*)$/;

const sessionSchema = z.strictObject({
  v: z.literal(1),
  sid: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  operator: z
    .strictObject({ id: z.string().min(1).max(100), key: z.string().min(1).max(200), createdAt: z.number().int().nonnegative() })
    .optional(),
  agents: z
    .array(z.strictObject({ id: z.string().min(1).max(100), name: z.string().min(1).max(100), seed: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }))
    .max(MAX_AGENT_KEYS),
});

export type Session = z.output<typeof sessionSchema>;
export type SessionAgent = Session['agents'][number];

/** A new session: a fresh `sid` (16 random bytes), no operator, no agent keys. */
export function newSession(): Session {
  return { v: 1, sid: randomBytes(16).toString('base64url'), agents: [] };
}

export function seal(session: Session, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/** The session in a sealed value, or undefined when it fails to unseal or is not a valid v1 session. */
export function unseal(value: string, key: Buffer): Session | undefined {
  const match = SEALED.exec(value);
  if (!match) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1] as string, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(Buffer.from(match[2] as string, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(match[3] as string, 'base64url')), decipher.final()]).toString('utf8');
    const parsed = sessionSchema.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The value of one cookie in a `Cookie` header. */
export function cookieValue(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The session of a request, or undefined (no cookie, a bad cookie, or an unknown `v`). */
export function readSession(request: Request, key: Buffer): Session | undefined {
  const value = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  return value === undefined ? undefined : unseal(value, key);
}

/** The `Set-Cookie` header value: HttpOnly, Path=/, SameSite=Lax, 30 days, Secure on https. */
export function sessionCookie(session: Session, key: Buffer, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${seal(session, key)}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Adds an agent key; past five keys the oldest is dropped. The agent itself is unchanged. */
export function withAgentKey(session: Session, agent: SessionAgent): Session {
  const agents = [...session.agents.filter((a) => a.id !== agent.id), agent];
  return { ...session, agents: agents.slice(-MAX_AGENT_KEYS) };
}

export function agentSeed(session: Session | undefined, agentId: string): string | undefined {
  return session?.agents.find((a) => a.id === agentId)?.seed;
}
