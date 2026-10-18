/**
 * Wiring for the `route.ts` files. The dependencies are resolved inside a try, so an invalid
 * variable (not only a missing one) answers the 503 of design spec §3.1, with a log line that names
 * the variable, instead of Next's bare 500.
 */
import 'server-only';
import { serverDeps, type WebDeps } from './deps';
import { errorResponse } from './handlers/common';

export async function withServerDeps(run: (deps: WebDeps) => Promise<Response>): Promise<Response> {
  let deps: WebDeps;
  try {
    deps = serverDeps();
  } catch (error) {
    return errorResponse(error);
  }
  return run(deps);
}
