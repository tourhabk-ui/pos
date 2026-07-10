/**
 * POST /api/admin/import/osm-geometry
 *
 * Fetches GPS track geometry from OpenStreetMap Overpass API for
 * kamchatka_routes that have no geometry yet.
 *
 * Body (JSON, all optional):
 *   limit   — max routes to process per call (default: 40, max: 80)
 *   dry_run — if true, query OSM but don't write to DB
 *
 * Returns:
 *   { ok, imported, skipped, errors, routes_without_geometry }
 *
 * Сам цикл импорта — в lib/import/osm-import-runner.ts (общий с
 * /api/cron/osm-import, который гоняет batched-прогон с прод-сервера).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { z } from 'zod';
import { runOsmGeometryImport } from '@/lib/import/osm-import-runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BodySchema = z.object({
  limit: z.number().int().min(1).max(80).default(40),
  dry_run: z.boolean().default(false),
}).default({});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = req.headers.get('content-type')?.includes('json')
      ? await req.json()
      : {};
    body = BodySchema.parse(raw);
  } catch {
    body = BodySchema.parse({});
  }

  const result = await runOsmGeometryImport({ limit: body.limit, dryRun: body.dry_run });

  return NextResponse.json({
    ok: true,
    dry_run: result.dry_run,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.length,
    error_details: result.errors.slice(0, 10),
    routes_without_geometry: result.routes_without_geometry,
    processed: result.processed,
    details: result.details.slice(0, 50),
  });
}
