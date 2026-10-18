// Browser calls to the web app's own API routes. Same origin, so the session cookie goes along.

export type ApiResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; message: string; body: Record<string, unknown> };

/** POSTs (or PUTs, PATCHes) JSON to one of our routes and reads `{ error, message }` on failure. */
export async function callApi<T extends Record<string, unknown>>(path: string, body?: unknown, method = 'POST'): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, error: 'network', message: "We couldn't reach PayPer402. Check your connection.", body: {} };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (res.ok) return { ok: true, ...(parsed as T) };
  return {
    ok: false,
    status: res.status,
    error: typeof parsed['error'] === 'string' ? parsed['error'] : 'error',
    message: typeof parsed['message'] === 'string' ? parsed['message'] : 'Something went wrong. Try again in a moment.',
    body: parsed,
  };
}

export function postSession(body: { role: 'operator' | 'seller'; startOver?: boolean }) {
  return callApi<{ next: string }>('/api/session', body);
}

/** Sends the browser to sign-in when the operator session ended (design spec §4.3). */
export function handleEnded(result: { ok: false; error: string }): boolean {
  if (result.error === 'session_ended' || result.error === 'no_session') {
    window.location.assign('/sign-in?ended=1');
    return true;
  }
  return false;
}
