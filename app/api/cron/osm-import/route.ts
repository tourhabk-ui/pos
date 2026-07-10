/**
 * GET /api/cron/osm-import — партия импорта GPS-треков из OSM Overpass
 * в kamchatka_routes.geometry, исполняемая НА прод-сервере.
 *
 * Зачем с прода: файрвол managed PostgreSQL Timeweb не пускает внешние IP
 * (три прогона с GitHub-раннера упали по connection timeout), а прод видит
 * БД нативно. Overpass (overpass-api.de) с прод-IP доступен.
 *
 * Дёргается workflow'ом import-osm-geometry-prod.yml с Bearer CRON_SECRET
 * в цикле по партиям (паттерн kvert-acc).
 *
 * Query: limit (1..10, default 8 — партия держится в пределах таймаута
 * прокси: ~8 x (Overpass + пауза 1.3с) ≈ 40с), dry_run=true|false,
 * offset (default 0 — сдвиг мимо skipped/error маршрутов, которые остаются
 * с geometry IS NULL и иначе зациклили бы перебор).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runOsmGeometryImport } from '@/lib/import/osm-import-runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const limit = intParam(sp.get('limit'), 8, 1, 10);
  const offset = intParam(sp.get('offset'), 0, 0, 10_000);
  const dryRun = sp.get('dry_run') === 'true';

  try {
    const result = await runOsmGeometryImport({ limit, dryRun, offset });
    return NextResponse.json({
      success: true,
      dry_run: result.dry_run,
      offset,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.length,
      error_details: result.errors.slice(0, 10),
      routes_without_geometry: result.routes_without_geometry,
      processed: result.processed,
      details: result.details,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка импорта OSM-геометрии';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
