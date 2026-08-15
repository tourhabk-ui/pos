/**
 * GET /api/cron/idilesom-gap — что есть у источника и чего нет у нас.
 *
 * Замысел владельца 15.08: «просмотрим idilesom — может у них есть
 * маршруты, которые у нас без геометрии; то, что не попало к нам».
 * Источник уже дал платформе ВСЕ настоящие треки (147, 424, 1707, 2569
 * вершин), а 109 живых маршрутов до сих пор стоят без линии — значит
 * сверить каталоги стоит прежде, чем искать треки где-то ещё.
 *
 * Сверка идёт по dedupe_key вида `idilesom:<id>` — метке, которой импорт
 * помечает всё принесённое. Три числа отвечают на вопрос целиком:
 *   have_with_track    — принесено и линия на месте;
 *   have_without_track — запись есть, а geometry пустая: кандидат на
 *                        добор трека (backfillIdilesomTracks);
 *   missing_entirely   — id источника, которого у нас нет вовсе.
 *
 * Только читает: ни строки в базу, ни одной страницы источника сверх
 * листинга — разбор конкретных страниц делает импортёр.
 *
 * Bearer CRON_SECRET. Параметр pages (1..50) ограничивает глубину
 * листинга, чтобы проба укладывалась в таймаут.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { fetchAllIds } from '@/lib/services/ingest/idilesom-importer';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SAMPLE_LIMIT = 80;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawPages = parseInt(request.nextUrl.searchParams.get('pages') ?? '50', 10);
  const pages = Number.isFinite(rawPages) ? Math.min(Math.max(rawPages, 1), 50) : 50;

  try {
    const listing = await fetchAllIds(pages);
    const sourceIds = listing.ids;
    const keys = sourceIds.map(id => `idilesom:${id}`);

    const { rows } = await pool.query<{
      dedupe_key: string; title: string; has_geometry: boolean;
      is_visible: boolean; merged: boolean;
    }>(
      `SELECT dedupe_key, title,
              (geometry IS NOT NULL) AS has_geometry,
              is_visible,
              (merged_into_id IS NOT NULL) AS merged
       FROM kamchatka_routes
       WHERE dedupe_key = ANY($1)`,
      [keys],
    );

    const byKey = new Map(rows.map(r => [r.dedupe_key, r]));
    const withTrack: string[] = [];
    const withoutTrack: Array<{ id: string; title: string; visible: boolean }> = [];
    const missing: string[] = [];

    for (const id of sourceIds) {
      const row = byKey.get(`idilesom:${id}`);
      if (!row) { missing.push(id); continue; }
      if (row.has_geometry) { withTrack.push(id); continue; }
      withoutTrack.push({ id, title: row.title, visible: row.is_visible });
    }

    return NextResponse.json({
      success: true,
      source_total: sourceIds.length,
      source_pages_requested: pages,
      listing_errors: listing.listingErrors,
      have_with_track: withTrack.length,
      have_without_track: withoutTrack.length,
      missing_entirely: missing.length,
      // Наши маршруты без линии, которых источник НЕ знает: их треки
      // придётся искать в другом месте (OSM, GPX, KML-инбокс).
      sample_without_track: withoutTrack.slice(0, SAMPLE_LIMIT),
      sample_missing_ids: missing.slice(0, SAMPLE_LIMIT),
      sample_dropped: Math.max(0, withoutTrack.length - SAMPLE_LIMIT)
        + Math.max(0, missing.length - SAMPLE_LIMIT),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка сверки с источником';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
