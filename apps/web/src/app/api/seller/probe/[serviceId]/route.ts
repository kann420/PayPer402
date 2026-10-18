import { withServerDeps } from '@/lib/route';
import { createProbeHandler } from '@/lib/handlers/seller';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ serviceId: string }> }): Promise<Response> {
  const { serviceId } = await context.params;
  return withServerDeps((deps) => createProbeHandler(deps)(request, serviceId));
}
