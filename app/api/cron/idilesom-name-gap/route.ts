/**
 * GET /api/cron/idilesom-name-gap — что качать из idilesom Pro РУКАМИ.
 *
 * Сверка по ИМЕНИ, а не по dedupe_key: прежняя сверка (idilesom-gap)
 * смотрела только метки импорта и потому не увидела «Курильское озеро» —
 * наша запись существовала под другим ключом, без линии, а у источника
 * трек был. Листинг источника содержит и id, и названия — этого достаточно,
 * чтобы сравнить их каталог с нашими дырами, не открывая ни одной страницы.
 *
 * Выход — список прямых ссылок для ручного скачивания владельцем:
 *   route_without_line — наша запись-тёзка есть, линии нет: KML ляжет сразу;
 *   place_without_line — маршрута-тёзки нет, но место без линии есть:
 *                        трек ляжет скрытой записью и даст месту линию
 *                        после ревью;
 * Записи, чьи тёзки у нас уже с линией, и записи, никому не тёзки, — только
 * счётчиками: первые качать незачем, вторые (54 без треков по разведке 89)
 * решаются отдельно.
 *
 * Имена сравниваются нормализацией KML-инбокса (normalizeTitle) — правило
 * одно, иначе сверка обещала бы совпадение, которого инбокс не увидит.
 *
 * READ-ONLY, Bearer CRON_SECRET. Параметр pages (1..50).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { fetchAllEntries } from '@/lib/services/ingest/idilesom-importer';
import { normalizeTitle } from '@/lib/import/kml-inbox';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawPages = parseInt(request.nextUrl.searchParams.get('pages') ?? '50', 10);
  const pages = Number.isFinite(rawPages) ? Math.min(Math.max(rawPages, 1), 50) : 50;

  try {
    const listing = await fetchAllEntries(pages);

    const routesRes = await pool.query<{ title: string; has_line: boolean }>(
      `SELECT title, (geometry IS NOT NULL) AS has_line
       FROM kamchatka_routes
       WHERE is_visible = true AND merged_into_id IS NULL`,
    );
    const placesRes = await pool.query<{ name: string; has_line: boolean }>(
      `SELECT p.name,
              EXISTS (
                SELECT 1 FROM route_waypoints rw
                JOIN kamchatka_routes r ON r.id = rw.route_id
                WHERE rw.place_id = p.id
                  AND r.is_visible = true AND r.merged_into_id IS NULL
                  AND r.geometry IS NOT NULL
              ) AS has_line
       FROM places p
       WHERE p.is_visible = true AND p.merged_into_id IS NULL`,
    );

    const routeByName = new Map<string, boolean>();
    for (const r of routesRes.rows) routeByName.set(normalizeTitle(r.title), r.has_line);
    const placeByName = new Map<string, boolean>();
    for (const p of placesRes.rows) placeByName.set(normalizeTitle(p.name), p.has_line);

    const routeWithoutLine: Array<{ id: string; title: string; url: string }> = [];
    const placeWithoutLine: Array<{ id: string; title: string; url: string }> = [];
    let alreadyTracked = 0;
    let unknownToUs = 0;
    let untitled = 0;

    for (const e of listing.entries) {
      if (e.title === '') { untitled++; continue; }
      const key = normalizeTitle(e.title);
      const url = `https://idilesom.com/kam/places/${e.id}`;
      const routeHasLine = routeByName.get(key);
      if (routeHasLine === false) { routeWithoutLine.push({ id: e.id, title: e.title, url }); continue; }
      if (routeHasLine === true) { alreadyTracked++; continue; }
      const placeHasLine = placeByName.get(key);
      if (placeHasLine === false) { placeWithoutLine.push({ id: e.id, title: e.title, url }); continue; }
      if (placeHasLine === true) { alreadyTracked++; continue; }
      unknownToUs++;
    }

    // Первый прогон (проба 97): 317 из 331 «неизвестны нам» при том, что 277
    // их треков у нас точно есть, — значит листинговые названия не совпадают
    // с нашими титулами (в якоре, видимо, не только имя). Образец сырых
    // названий делает причину видимой вместо гадания.
    const unknownSample = listing.entries
      .filter(e => e.title !== ''
        && !routeByName.has(normalizeTitle(e.title))
        && !placeByName.has(normalizeTitle(e.title)))
      .slice(0, 12)
      .map(e => ({ id: e.id, title: e.title }));

    return NextResponse.json({
      success: true,
      probe: 'name_gap_v2',
      source_entries: listing.entries.length,
      listing_errors: listing.listingErrors,
      untitled_entries: untitled,
      already_tracked: alreadyTracked,
      unknown_to_us: unknownToUs,
      unknown_sample: unknownSample,
      download_route_without_line: routeWithoutLine,
      download_place_without_line: placeWithoutLine,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка именной сверки с источником';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
