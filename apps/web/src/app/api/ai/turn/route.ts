import { withServerDeps } from '@/lib/route';
import { createAiTurnHandler, realAiDeps } from '@/lib/handlers/ai-turn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return withServerDeps((deps) => createAiTurnHandler(deps, realAiDeps())(request));
}
