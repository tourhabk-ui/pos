/**
 * POST /api/cron/idilesom-scout — разведка страниц источника, которых у нас нет.
 *
 * Сверка (проба 75) показала: у idilesom 331 запись, 277 принесены к нам с
 * треками, ни одной недобранной, а 54 идентификатора у нас отсутствуют
 * вовсе. Скорее всего их отбраковала тройная дедупликация импорта
 * (совпадение координат в пределах 500 м или пересечение слов в имени) —
 * и вместе с записью потерялся её ТРЕК.
 *
 * Разведчик открывает такие страницы и кладёт рядом два факта:
 *   что там (название, тип, координаты, длина и размер трека);
 *   с чем совпало у нас (ближайшее живое место, расстояние, есть ли у
 *   него линия на карте вообще).
 *
 * Отсюда видно, где трек действительно новый и его стоит внести, а где
 * это честный дубль уже покрытого места. Решение — за человеком:
 * НИЧЕГО НЕ ПИШЕТ. Работает только с прода: idilesom отдаёт страницы по
 * IP Timeweb, с раннера у него бот-защита.
 *
 * Bearer CRON_SECRET. Body: { ids: string[] (1..12) } — партия невелика
 * намеренно: каждая страница это запрос к чужому сайту.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { scrapePage, fetchTextWithFallback } from '@/lib/services/ingest/idilesom-importer';
import { trackLengthKm, type Coord } from '@/lib/routes/track-length';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BodySchema = z.object({
  ids: z.array(z.string().min(1).max(12)).min(1).max(12),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  const items: Array<Record<string, unknown>> = [];

  try {
    for (const id of data.ids) {
      // eslint-disable-next-line no-await-in-loop
      const page = await scrapePage(id);
      if (!page) {
        // Разбор молчит об одном «нет», за которым стоят три разные
        // причины: сайт не отдал страницу, страница есть но не про
        // географию, страницы нет вовсе. Не различив их, вывода не
        // сделать — поэтому диагностируем сырым запросом.
        // eslint-disable-next-line no-await-in-loop
        const raw = await fetchTextWithFallback(`https://idilesom.com/kam/places/${id}`);
        if (raw.text === null) {
          items.push({ id, status: 'источник не отдал страницу', reason: raw.error.slice(0, 160) });
          continue;
        }
        const html = raw.text;
        const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ?? null;
        const hasCoords = /"latitude"\s*:\s*[\d.]+/.test(html);
        const trackBlocks = (html.match(/\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g) ?? []).length;
        items.push({
          id,
          status: 'страница есть, но разбор её отверг',
          htmlBytes: html.length,
          ogTitle,
          hasCoords,
          trackBlocks,
        });
        continue;
      }

      const coords = page.coordinates
        .filter(c => Array.isArray(c) && c.length >= 2)
        .map(c => [c[0], c[1]] as Coord);
      const lengthKm = trackLengthKm(coords);

      // Ближайшее живое место и его покрытие линией: именно с ним запись
      // источника, скорее всего, и слилась при импорте.
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query<{
        name: string; distance_km: string; has_line: boolean;
      }>(
        `SELECT p.name,
                (6371 * acos(LEAST(1.0,
                   cos(radians($1::float)) * cos(radians(p.lat::float)) *
                   cos(radians(p.lng::float) - radians($2::float)) +
                   sin(radians($1::float)) * sin(radians(p.lat::float))
                 )))::numeric(10,2) AS distance_km,
                EXISTS (
                  SELECT 1 FROM route_waypoints rw
                  JOIN kamchatka_routes r ON r.id = rw.route_id
                  WHERE rw.place_id = p.id
                    AND r.is_visible = true AND r.merged_into_id IS NULL
                    AND r.geometry IS NOT NULL
                ) AS has_line
         FROM places p
         WHERE p.is_visible = true AND p.merged_into_id IS NULL
           AND p.lat IS NOT NULL AND p.lng IS NOT NULL
         ORDER BY (p.lat::float - $1::float)^2 + (p.lng::float - $2::float)^2
         LIMIT 1`,
        [page.lat, page.lng],
      );

      const near = rows[0];
      items.push({
        id,
        title: page.title,
        type: page.locationType,
        lat: page.lat, lng: page.lng,
        vertices: coords.length,
        trackKm: lengthKm,
        nearestPlace: near?.name ?? null,
        nearestKm: near ? Number(near.distance_km) : null,
        nearestHasLine: near?.has_line ?? null,
        // Ценность находки: трек есть, а у ближайшего места линии нет.
        worthImport: coords.length >= 5 && near != null && !near.has_line,
      });
    }

    return NextResponse.json({
      success: true,
      scouted: items.length,
      with_track: items.filter(i => (i.vertices as number ?? 0) >= 5).length,
      worth_import: items.filter(i => i.worthImport === true).length,
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка разведки';
    return NextResponse.json({ success: false, error: message, scouted: items.length, items }, { status: 502 });
  }
}
