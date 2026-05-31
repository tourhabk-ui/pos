/**
 * POST /api/admin/import/osm-geometry
 *
 * Fetches GPS track geometry from OpenStreetMap Overpass API for
 * kamchatka_routes that have no geometry yet.
 *
 * Body (JSON, all optional):
 *   limit   — max routes to process per call (default: 40, max: 80)
 *   dry_run — if true, query OSM but don't write to DB
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { runOsmGeometryImport } from '@/lib/agents/osm-geometry-import';
import { z } from 'zod';

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

  const result = await runOsmGeometryImport(body.limit, body.dry_run);
  return NextResponse.json({ ok: true, dry_run: body.dry_run, ...result });
}
