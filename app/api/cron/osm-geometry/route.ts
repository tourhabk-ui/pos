/**
 * GET /api/cron/osm-geometry
 *
 * Автоматически загружает GPS-треки из OpenStreetMap для маршрутов
 * без geometry. Запускается каждые 8 часов через GitHub Actions.
 *
 * При 294 маршрутах и 40 за запуск — все треки появятся за ~3 дня.
 * После этого endpoint тихо возвращает { ok: true, processed: 0 }.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runOsmGeometryImport } from '@/lib/agents/osm-geometry-import';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: Request) {
  const authHeader = req instanceof Request ? req.headers.get('authorization') : null;
  const secret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const start = new Date();
  const result = await runOsmGeometryImport(40);

  await logAgentRun({
    agent_id: 'osm-geometry-import',
    status: result.errors > 0 && result.imported === 0 ? 'failed' : result.errors > 0 ? 'partial' : 'success',
    started_at: start,
    duration_ms: Date.now() - start.getTime(),
    items_processed: result.processed,
    items_created: result.imported,
    errors_count: result.errors,
    metadata: { skipped: result.skipped, remaining: result.routes_without_geometry },
  });

  return Response.json({ ok: true, ...result });
}
