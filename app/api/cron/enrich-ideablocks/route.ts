/**
 * GET /api/cron/enrich-ideablocks?secret=...&batch=50&source=places|routes|all
 *
 * Обогащает базу через Blockify IdeaBlocks API.
 * Берёт N необработанных мест/маршрутов → Blockify ingest → сохраняет в ideablocks.
 *
 * Free tier: 100 req/day, 10 req/min → 6.2s между запросами.
 * Запускается ежедневно через GitHub Actions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { ingestText, type IdeaBlock } from '@/lib/services/blockify';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') ?? '';
  const cronSecret = process.env.CRON_SECRET ?? '';
  if (!cronSecret || !timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.BLOCKIFY_API_KEY) {
    return NextResponse.json({ skipped: true, reason: 'BLOCKIFY_API_KEY not configured' }, { status: 200 });
  }

  const batch = Math.min(parseInt(req.nextUrl.searchParams.get('batch') ?? '25'), 40);
  const source = req.nextUrl.searchParams.get('source') ?? 'all';

  const stats = { places: 0, routes: 0, blocks: 0, errors: 0 };

  try {
    if (source === 'all' || source === 'places') {
      await enrichPlaces(batch, stats);
    }
    const remaining = batch - stats.places;
    if (remaining > 0 && (source === 'all' || source === 'routes')) {
      await enrichRoutes(remaining, stats);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, stats }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stats });
}

type Stats = { places: number; routes: number; blocks: number; errors: number };

async function enrichPlaces(limit: number, stats: Stats) {
  const res = await pool.query<{ id: string; name: string; description: string; location_type: string }>(
    `SELECT p.id, p.name, p.description, p.location_type
     FROM places p
     WHERE p.description IS NOT NULL AND length(p.description) > 50
       AND NOT EXISTS (SELECT 1 FROM ideablocks ib WHERE ib.source_id = p.id AND ib.source_type = 'place')
     ORDER BY p.name
     LIMIT $1`,
    [limit],
  );

  for (const row of res.rows) {
    try {
      const text = `${row.name}\n\nТип: ${row.location_type}\n\n${row.description}`;
      const blocks = await ingestText(text, { chunkSize: 2000, delayMs: 6200 });
      await saveBlocks(blocks, 'place', row.id, row.name, row.location_type);
      stats.places++;
      stats.blocks += blocks.length;
    } catch {
      stats.errors++;
    }
    await sleep(6200);
  }
}

async function enrichRoutes(limit: number, stats: { places: number; routes: number; blocks: number; errors: number }) {
  const res = await pool.query<{ id: string; title: string; description: string; category: string | null }>(
    `SELECT r.id, r.title, LEFT(r.description, 2000) AS description, r.category
     FROM kamchatka_routes r
     WHERE r.description IS NOT NULL AND length(r.description) > 50
       AND NOT EXISTS (SELECT 1 FROM ideablocks ib WHERE ib.source_id = r.id AND ib.source_type = 'route')
     ORDER BY r.title
     LIMIT $1`,
    [limit],
  );

  for (const row of res.rows) {
    try {
      const text = `${row.title}\n\nКатегория: ${row.category ?? 'маршрут'}\n\n${row.description}`;
      const blocks = await ingestText(text, { chunkSize: 2000, delayMs: 6200 });
      await saveBlocks(blocks, 'route', row.id, row.title, row.category ?? 'route');
      stats.routes++;
      stats.blocks += blocks.length;
    } catch {
      stats.errors++;
    }
    await sleep(6200);
  }
}

async function saveBlocks(
  blocks: IdeaBlock[],
  sourceType: 'place' | 'route',
  sourceId: string,
  entityName: string,
  entityType: string,
) {
  for (const b of blocks) {
    await pool.query(
      `INSERT INTO ideablocks
         (id, source_type, source_id, name, critical_question, trusted_answer, tags, keywords, entity_name, entity_type)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [b.id, sourceType, sourceId, b.name, b.criticalQuestion, b.trustedAnswer,
       b.tags, b.keywords, entityName, entityType],
    );
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
