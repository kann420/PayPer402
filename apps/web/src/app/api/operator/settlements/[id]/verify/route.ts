import { withServerDeps } from '@/lib/route';
import { createVerifySettlementHandler } from '@/lib/handlers/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return withServerDeps((deps) => createVerifySettlementHandler(deps)(request, id));
}
