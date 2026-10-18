import { withServerDeps } from '@/lib/route';
import { createCapsHandler } from '@/lib/handlers/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request): Promise<Response> {
  return withServerDeps((deps) => createCapsHandler(deps)(request));
}
