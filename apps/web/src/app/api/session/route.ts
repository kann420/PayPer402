import { withServerDeps } from '@/lib/route';
import { createSessionHandler } from '@/lib/handlers/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return withServerDeps((deps) => createSessionHandler(deps)(request));
}
