import { withServerDeps } from '@/lib/route';
import { createEventsHandler } from '@/lib/handlers/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withServerDeps((deps) => createEventsHandler(deps)(request));
}
