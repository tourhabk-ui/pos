/**
 * GET /api/cron/route-title-census — какие имена маршрутов не по стандарту.
 *
 * Стандарт и судья — lib/routes/title-standard.ts (решение владельца 20.08:
 * один формат, без поэзии). Перепись только судит: для каждого живого
 * маршрута с нарушениями — имя, признаки и привязанные места (материал для
 * ручного переименования: канон почти всегда собирается из объекта, через
 * который маршрут проходит). Ничего не переименовывает — новое имя сочиняет
 * смысл, это решение человека, партиями.
 *
 * READ-ONLY, Bearer CRON_SECRET. Параметры offset/limit — окно выдачи.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { judgeRouteTitle } from '@/lib/routes/title-standard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const rawOffset = parseInt(sp.get('offset') ?? '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 40;

  try {
    const { rows } = await pool.query<{
      id: string; title: string; waypoint_names: string[] | null;
      description_head: string | null; nearest_places: string[] | null;
    }>(
      `SELECT r.id::text AS id, r.title,
              LEFT(r.description, 240) AS description_head,
              ARRAY(
                SELECT p.name FROM route_waypoints rw
                JOIN places p ON p.id = rw.place_id
                WHERE rw.route_id = r.id
                  AND p.is_visible = true AND p.merged_into_id IS NULL
                ORDER BY rw.position
              ) AS waypoint_names,
              -- Ближайшие живые места к координате маршрута (~до 17 км по
              -- широте) — материал для канона, когда объекта нет ни в имени,
              -- ни в описании: имя берётся от реального соседа, не
              -- сочиняется. Дистанция плоская (широта 111 км/°, долгота
              -- 67 км/° на ~53°N) — для ранжирования и грубой оценки хватает.
              ARRAY(
                SELECT p2.name || ' ~' ||
                       ROUND(sqrt(power(111.0 * (p2.lat::float8 - r.lat::float8), 2)
                                + power(67.0 * (p2.lng::float8 - r.lng::float8), 2))::numeric, 1)
                       || ' км'
                FROM places p2
                WHERE r.lat IS NOT NULL AND r.lng IS NOT NULL
                  AND p2.is_visible = true AND p2.merged_into_id IS NULL
                  AND p2.lat IS NOT NULL AND p2.lng IS NOT NULL
                  AND p2.lat::float8 BETWEEN r.lat::float8 - 0.15 AND r.lat::float8 + 0.15
                  AND p2.lng::float8 BETWEEN r.lng::float8 - 0.25 AND r.lng::float8 + 0.25
                ORDER BY power(111.0 * (p2.lat::float8 - r.lat::float8), 2)
                       + power(67.0 * (p2.lng::float8 - r.lng::float8), 2)
                LIMIT 3
              ) AS nearest_places
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
       ORDER BY r.title`,
    );

    const offenders = rows
      .map(r => ({ ...r, verdict: judgeRouteTitle(r.title) }))
      .filter(r => !r.verdict.ok)
      .map(r => ({
        id: r.id,
        title: r.title,
        violations: r.verdict.violations,
        places: r.waypoint_names ?? [],
        // Начало описания — материал для канона, когда объекта нет ни в
        // имени, ни в привязанных местах («Зимняя сказка»): новое имя
        // берётся из данных маршрута, не сочиняется. null — описания нет,
        // и это честный ответ (кандидат на скрытие, решает владелец).
        description_head: r.description_head,
        // Соседи по координате маршрута: пустой список — координаты нет или
        // рядом нет живых мест; это честный ответ, не повод выдумывать.
        nearest_places: r.nearest_places ?? [],
      }));

    const byViolation: Record<string, number> = {};
    for (const o of offenders) {
      for (const v of o.violations) {
        const key = v.split(':')[0];
        byViolation[key] = (byViolation[key] ?? 0) + 1;
      }
    }

    return NextResponse.json({
      success: true,
      // v3 — маркер деплоя миграции 886 (доводка слияния: id двух пространств,
      // ark_id против kamchatka_routes.id — урок search-выдачи): код переписи не
      // менялся, пробе нужен признак сборки, при старте которой она прошла.
      // v4 — миграция 887 (слитая ⇒ скрыта: «видимые, но слитые» после
      // restore близнецов) + фильтр слитости в /api/routes/search.
      // v5 — миграция 888 (переименование партии 1, «го» владельца 20.08).
      // v6 — миграция 889 (партия 2) + description_head в items: канон для
      // безобъектных имён берётся из данных маршрута, не выдумывается.
      // v7 — миграция 890 (партия 3 из описаний) + nearest_places в items:
      // для 8 безобъектных имён канон ищется у реального соседа по координате.
      // v8 — миграция 891 (партия 4 от соседей по координате): нарушителей
      // должно остаться 2 — «Зимняя сказка» и «Чудеса Камчатки», без единой
      // зацепки в данных; их судьба — решение владельца.
      probe: 'title_census_v8',
      live_total: rows.length,
      offenders_total: offenders.length,
      by_violation: byViolation,
      window: { offset, limit },
      items: offenders.slice(offset, offset + limit),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи имён';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
