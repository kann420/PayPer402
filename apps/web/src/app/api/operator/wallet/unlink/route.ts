import { withServerDeps } from '@/lib/route';
import { createUnlinkHandler } from '@/lib/handlers/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return withServerDeps((deps) => createUnlinkHandler(deps)(request));
}
