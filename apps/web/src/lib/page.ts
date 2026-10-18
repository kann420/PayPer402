/**
 * Page guards for server components (design spec §4.3). Pages only read the cookie; they never set
 * or delete it.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverDeps, type WebDeps } from './deps';
import { isFacilitatorError, type OperatorApi, type SellerApi } from './facilitator';
import { SESSION_COOKIE, unseal, type Session } from './session';
import { required } from './config';

export async function pageSession(): Promise<Session | undefined> {
  const deps = serverDeps();
  const key = deps.config.sessionSecret;
  if (key === undefined) return undefined;
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return value === undefined ? undefined : unseal(value, key);
}

export interface OperatorPage {
  deps: WebDeps;
  session: Session & { operator: NonNullable<Session['operator']> };
  api: OperatorApi;
}

/** `/app/**`: a valid session holding an operator, or a redirect to `/sign-in`. */
export async function operatorPage(): Promise<OperatorPage> {
  const session = await pageSession();
  if (session?.operator === undefined) redirect('/sign-in');
  const deps = serverDeps();
  return { deps, session: session as OperatorPage['session'], api: deps.facilitator.operator(session.operator.key) };
}

export interface SellerPage {
  deps: WebDeps;
  session: Session;
  api: SellerApi;
}

/** `/seller/**`: any valid session, or a redirect to `/sign-in`. */
export async function sellerPage(): Promise<SellerPage> {
  const session = await pageSession();
  if (session === undefined) redirect('/sign-in');
  const deps = serverDeps();
  return { deps, session, api: deps.facilitator.seller(required(deps.config.sellerKey, 'WEB_SELLER_API_KEY')) };
}

/**
 * Runs facilitator reads for a page. An ended operator session redirects to `/sign-in?ended=1`;
 * anything else propagates to the error page.
 */
export async function load<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isFacilitatorError(error) && error.code === 'session_ended') redirect('/sign-in?ended=1');
    throw error;
  }
}

/** The session operator's name for the seller pages' switcher, if the session holds a working one. */
export async function sessionOperatorName(): Promise<string | undefined> {
  const session = await pageSession();
  if (session?.operator === undefined) return undefined;
  try {
    return (await serverDeps().facilitator.operator(session.operator.key).get()).operator.name;
  } catch {
    return undefined;
  }
}
