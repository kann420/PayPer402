import { withServerDeps } from '@/lib/route';
import { createRunsHandler, realRunDeps } from '@/lib/handlers/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 200;

export function POST(request: Request): Promise<Response> {
  return withServerDeps((deps) => createRunsHandler(deps, realRunDeps())(request));
}
