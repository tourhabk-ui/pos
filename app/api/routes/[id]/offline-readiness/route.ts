/**
 * GET /api/routes/[id]/offline-readiness
 *
 * Офлайн-проверка целостности SOS-пакета маршрута перед выходом (issue #246):
 * турист видит, какие данные маршрута реально доступны офлайн, до выхода
 * на тропу без связи.
 */

import { checkRouteOfflineReadiness } from '@/lib/services/offline-readiness';

// AUTH: Public — как offline-bundle (app/api/routes/[id]/offline-bundle),
// данные маршрута публичные.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'Invalid ID' }, { status: 400 });
  }

  const result = await checkRouteOfflineReadiness(id);
  if (!result) return Response.json({ error: 'Not found' }, { status: 404 });

  return Response.json(result);
}
