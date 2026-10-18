import { withServerDeps } from '@/lib/route';
import { createPatchAgentHandler } from '@/lib/handlers/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return withServerDeps((deps) => createPatchAgentHandler(deps)(request, id));
}
