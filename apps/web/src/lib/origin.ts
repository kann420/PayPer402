/**
 * The same-origin check (design spec §15.2): every state-changing route compares `Origin`, or
 * without it `Referer`, with the web app's own origin. It comes on top of `SameSite=Lax`.
 */
export function sameOrigin(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== '' && origin !== 'null') return origin === publicOrigin;
  const referer = request.headers.get('referer');
  if (referer === null || referer === '') return false;
  try {
    return new URL(referer).origin === publicOrigin;
  } catch {
    return false;
  }
}
