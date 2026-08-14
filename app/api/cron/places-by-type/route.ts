/**
 * GET /api/cron/places-by-type — срез мест по виду. Bearer CRON_SECRET.
 * Только читает.
 *
 * Зачем. Разбирать 460 мест подряд нельзя — глаз замыливается на третьем
 * десятке. По видам проще: вулканы сравниваются с вулканами, источники с
 * источниками, и дубль виден сразу («Шишель» и «Гора Шишель» — один вулкан,
 * «Смотровая точка Б» и «точка В» — две разные площадки).
 *
 * Без `type` — перепись по видам: сколько чего есть. С `type` — полный список
 * этого вида.
 *
 * ── Почему не просто список ────────────────────────────────────────────────
 *
 * Список из ста строк — это опять работа глазами. Поэтому у каждого места
 * посчитан БЛИЖАЙШИЙ СОСЕД ТОГО ЖЕ ВИДА: имя, расстояние, похожесть. Строки
 * идут по расстоянию, так что кандидаты в дубли собираются наверху сами, а
 * низ списка — места, у которых соседей рядом нет вовсе.
 *
 * Сосед считается только между местами с настоящими координатами. Места без
 * GPS сидят либо в 0,0, либо в плейсхолдере 53.0444/158.6483 (центр
 * Петропавловска, миграция 660): расстояние между двумя такими равно нулю, и
 * без этого условия они бы возглавили список, не будучи дублями. Урок из
 * /api/admin/places/duplicates, где на этом уже обожглись.
 *
 * Решения тут не принимаются: это чтение для человека. Слияние — отдельным
 * поимённым вызовом /api/cron/places-dedup, мягко и обратимо.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const QuerySchema = z.object({
  type: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Настоящие координаты: не NULL, не 0,0 и не плейсхолдер миграции 660. */
const REAL_COORDS = (a: string) => `
  ${a}.lat IS NOT NULL AND ${a}.lng IS NOT NULL
  AND NOT (${a}.lat = 0 AND ${a}.lng = 0)
  AND NOT (ROUND(${a}.lat::numeric,4) = 53.0444 AND ROUND(${a}.lng::numeric,4) = 158.6483)`;

const DIST_M = (a: string, b: string) => `6371000 * acos(LEAST(1, GREATEST(-1,
  cos(radians(${a}.lat)) * cos(radians(${b}.lat)) * cos(radians(${b}.lng) - radians(${a}.lng)) +
  sin(radians(${a}.lat)) * sin(radians(${b}.lat))
)))`;

interface TypeRow {
  type: string;
  count: string;
}

interface PlaceRow {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  is_visible: boolean;
  has_photo: boolean;
  has_safety: boolean;
  altitude_m: number | null;
  source_name: string | null;
  near_id: string | null;
  near_name: string | null;
  dist_m: number | null;
  sim: number | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Неверные параметры' },
      { status: 400 },
    );
  }
  const { type, limit } = parsed.data;

  try {
    if (!type) {
      const { rows } = await pool.query<TypeRow>(
        `SELECT COALESCE(NULLIF(TRIM(location_type), ''), '(не указан)') AS type,
                COUNT(*)::text AS count
           FROM places
          WHERE merged_into_id IS NULL
          GROUP BY 1
          ORDER BY COUNT(*) DESC, 1 ASC`,
      );
      return NextResponse.json({
        success: true,
        types: rows.map((r) => ({ type: r.type, count: parseInt(r.count, 10) })),
      });
    }

    const { rows } = await pool.query<PlaceRow>(
      `WITH p AS (
         SELECT id::text AS id, name, lat, lng, ark_id, is_visible, source_name
           FROM places
          WHERE merged_into_id IS NULL
            AND LOWER(TRIM(COALESCE(location_type, ''))) = LOWER($1)
       )
       SELECT p.id, p.name, p.lat, p.lng, p.is_visible, p.source_name,
              (ari.route_id IS NOT NULL)     AS has_photo,
              (lsp.agent_route_id IS NOT NULL) AS has_safety,
              lsp.altitude_m,
              n.id AS near_id, n.name AS near_name, n.dist_m, n.sim
         FROM p
         LEFT JOIN ai_route_images ari        ON ari.route_id = p.ark_id
         LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
         LEFT JOIN LATERAL (
           SELECT q.id, q.name,
                  ${DIST_M('p', 'q')} AS dist_m,
                  similarity(p.name, q.name) AS sim
             FROM p q
            WHERE q.id <> p.id
              AND ${REAL_COORDS('p')}
              AND ${REAL_COORDS('q')}
            ORDER BY dist_m ASC
            LIMIT 1
         ) n ON TRUE
        ORDER BY n.dist_m ASC NULLS LAST, p.name ASC
        LIMIT $2`,
      [type, limit],
    );

    return NextResponse.json({
      success: true,
      type,
      total: rows.length,
      places: rows.map((r) => ({
        id: r.id,
        name: r.name,
        lat: r.lat,
        lng: r.lng,
        visible: r.is_visible,
        photo: r.has_photo,
        safety: r.has_safety,
        // Высота и источник — различители, без которых по одному расстоянию
        // не отличить дубль с испорченной геопозицией от разных объектов с
        // похожими именами. Для вулкана высота — самый надёжный признак
        // тождества: у Камня 4585 м, у Хангара около двух тысяч, и перепутать
        // их нельзя. Источник говорит, какой импорт принёс запись.
        altM: r.altitude_m,
        src: r.source_name,
        // Ближайший сосед того же вида. null — соседей с настоящими
        // координатами нет; это тоже ответ, а не пустое место.
        near: r.near_id
          ? {
              id: r.near_id,
              name: r.near_name,
              distM: r.dist_m === null ? null : Math.round(r.dist_m),
              sim: r.sim === null ? null : Math.round(r.sim * 100) / 100,
            }
          : null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка среза мест по виду';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
