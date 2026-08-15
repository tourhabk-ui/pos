/**
 * POST /api/cron/route-twins-enrich — дооформить маршруты с треком, но без
 * метаданных (решение владельца 15.08: «дооформить их, посчитать дистанцию
 * и привязать места»).
 *
 * Это те самые 107 записей, которые сухая уборка (проба 65) отказалась
 * скрывать: у каждой есть настоящий снятый трек (idilesom, у одной osm),
 * а метаданных нет — ни дистанции, ни связи с местом. Мусором они
 * выглядели только по имени; на деле это единственные настоящие треки,
 * какие есть у платформы.
 *
 * Два действия, решаемые НЕЗАВИСИМО (правила — lib/routes/track-length.ts):
 *   - distance_km считается ИЗ ТРЕКА и пишется только в пустоту;
 *   - место-тёзка привязывается точкой маршрута, если трек проходит
 *     рядом с ним (иначе связь была бы ложью: у «Озера Икар» трек лежит
 *     в 337 км от самого озера).
 *
 * Bearer CRON_SECRET. Body: { dry_run (default true), limit (1..60), ids? }.
 * Идемпотентно: повторный прогон не портит уже заполненное.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import {
  trackLengthKm, nearestVertexKm, enrichVerdict, type Coord,
} from '@/lib/routes/track-length';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Боевой прогон идёт партиями не больше десяти (решение владельца
 * 15.08: «лучше по 10, чтоб меньше ошибок допустить»). Ограничение
 * живёт в коде, а не в договорённости: разбор партии — ручная работа
 * глазами, и на тридцати записях внимание кончается раньше списка.
 * Сухому прогону простор оставлен — он ничего не меняет.
 */
const LIVE_BATCH_MAX = 10;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  limit: z.number().int().min(1).max(60).default(LIVE_BATCH_MAX),
  ids: z.array(z.string().min(8).max(64)).max(60).optional(),
});

interface Row {
  id: string; title: string;
  place_id: string; place_lat: number | null; place_lng: number | null;
  coordinates: unknown;
  has_distance: boolean; waypoint_count: number;
  geometry_source: string | null;
}

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

  const liveSize = data.ids ? data.ids.length : data.limit;
  if (!data.dry_run && liveSize > LIVE_BATCH_MAX) {
    return NextResponse.json(
      {
        success: false,
        error: `Боевой прогон — партиями не больше ${LIVE_BATCH_MAX}: запрошено ${liveSize}`,
      },
      { status: 400 },
    );
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT r.id::text AS id, r.title,
              p.id::text AS place_id, p.lat AS place_lat, p.lng AS place_lng,
              r.geometry->'coordinates' AS coordinates,
              (r.distance_km IS NOT NULL) AS has_distance,
              (SELECT COUNT(*)::int FROM route_waypoints rw WHERE rw.route_id = r.id) AS waypoint_count,
              r.geometry->>'source' AS geometry_source
       FROM kamchatka_routes r
       JOIN places p
         ON p.is_visible = true AND p.merged_into_id IS NULL
        AND lower(translate(btrim(p.name), 'ё', 'е')) = lower(translate(btrim(r.title), 'ё', 'е'))
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
         AND r.geometry->>'type' = 'LineString'
         AND (r.distance_km IS NULL
              OR NOT EXISTS (SELECT 1 FROM route_waypoints rw WHERE rw.route_id = r.id))
       ORDER BY r.title
       LIMIT $1`,
      [data.ids ? 60 : data.limit],
    );

    const chosen = data.ids ? rows.filter(r => data.ids!.includes(r.id)) : rows;

    interface Item {
      id: string; title: string; lengthKm: number; vertices: number;
      placeOffsetKm: number | null; source: string | null;
      willWriteDistance: boolean; willLinkPlace: boolean; notes: string[];
      wroteDistance?: boolean; linkedPlace?: boolean;
    }
    const items: Item[] = [];

    for (const r of chosen) {
      const coords = Array.isArray(r.coordinates) ? (r.coordinates as Coord[]) : [];
      const valid = coords.filter(
        c => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number',
      );
      const lat = r.place_lat == null ? null : Number(r.place_lat);
      const lng = r.place_lng == null ? null : Number(r.place_lng);
      const lengthKm = trackLengthKm(valid);
      const placeOffsetKm = (lat != null && lng != null && valid.length > 0)
        ? nearestVertexKm(valid, lat, lng)
        : null;

      const verdict = enrichVerdict({ lengthKm, placeOffsetKm, vertexCount: valid.length });
      // Уже заполненное не переписываем: дистанция могла прийти из
      // паспорта маршрута, а она вернее посчитанной по треку.
      const willWriteDistance = verdict.writeDistance && !r.has_distance;
      const willLinkPlace = verdict.linkPlace && r.waypoint_count === 0;

      items.push({
        id: r.id, title: r.title, lengthKm, vertices: valid.length,
        placeOffsetKm, source: r.geometry_source,
        willWriteDistance, willLinkPlace, notes: verdict.notes,
      });
    }

    if (data.dry_run) {
      return NextResponse.json({
        success: true, dry_run: true,
        candidates: items.length,
        would_write_distance: items.filter(i => i.willWriteDistance).length,
        would_link_place: items.filter(i => i.willLinkPlace).length,
        untouched: items.filter(i => !i.willWriteDistance && !i.willLinkPlace).length,
        items,
      });
    }

    for (const item of items) {
      if (!item.willWriteDistance && !item.willLinkPlace) continue;
      const row = chosen.find(r => r.id === item.id)!;
      // eslint-disable-next-line no-await-in-loop
      await transaction(async (client) => {
        if (item.willWriteDistance) {
          const upd = await client.query(
            `UPDATE kamchatka_routes SET distance_km = $1, updated_at = NOW()
             WHERE id::text = $2 AND distance_km IS NULL`,
            [item.lengthKm, item.id],
          );
          item.wroteDistance = (upd.rowCount ?? 0) > 0;
        }
        if (item.willLinkPlace) {
          const ins = await client.query(
            `INSERT INTO route_waypoints (route_id, place_id, position)
             SELECT r.id, p.id,
                    COALESCE((SELECT MAX(rw.position) FROM route_waypoints rw WHERE rw.route_id = r.id), 0) + 1
             FROM kamchatka_routes r, places p
             WHERE r.id::text = $1 AND p.id::text = $2
             ON CONFLICT (route_id, place_id) DO NOTHING`,
            [item.id, row.place_id],
          );
          item.linkedPlace = (ins.rowCount ?? 0) > 0;
        }
      });
    }

    return NextResponse.json({
      success: true, dry_run: false,
      distance_written: items.filter(i => i.wroteDistance).length,
      places_linked: items.filter(i => i.linkedPlace).length,
      untouched: items.filter(i => !i.wroteDistance && !i.linkedPlace).length,
      done: items.map(i => ({
        title: i.title, km: i.lengthKm, distance: !!i.wroteDistance,
        place: !!i.linkedPlace, notes: i.notes,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка дооформления';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
