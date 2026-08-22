/**
 * GET /api/field-check/routes?q= — поиск маршрута для полевой проверки.
 *
 * Владелец 21.08: «нужен маршрут туда добавить, они собираются не на одну
 * локацию». Проверка «что рядом со мной» отвечает на вопрос стоящего на
 * месте; выход по маршруту устроен иначе — точки известны заранее, и
 * готовиться к ним надо дома, пока есть сеть.
 *
 * Отдаёт живые маршруты по имени вместе с числом путевых точек: по нему
 * сразу видно, есть ли что обходить (у части маршрутов точек нет вовсе —
 * это честный ответ, а не пустой список).
 *
 * С 22.08 отдаёт и МЕСТА с тем же именем. Повод: владелец стоял в Паратунке
 * и не нашёл в форме Вилючинский перевал. Записи не было в списке потому,
 * что список — это «что в 15 км», а перевал в шестидесяти. Поиск по имени,
 * который ищет только среди уже показанного, отвечает «не найдено» и на
 * «нет рядом», и на «нет в базе» — два разных ответа одним словом. Теперь
 * спросить можно всю базу, и «нет» будет означать ровно «нет».
 *
 * Публичный read-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const QuerySchema = z.object({ q: z.string().min(2).max(80) });

export async function GET(request: NextRequest) {
  const parsed = QuerySchema.safeParse({ q: request.nextUrl.searchParams.get('q') ?? '' });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Нужно название маршрута — хотя бы два символа' },
      { status: 400 },
    );
  }

  try {
    const { rows } = await pool.query(
      `SELECT r.id::text AS id, r.title,
              r.lat::float8 AS lat, r.lng::float8 AS lng,
              COALESCE((SELECT COUNT(*) FROM route_waypoints w
                WHERE w.route_id = r.id
                  AND COALESCE(w.link_kind, 'unknown') <> 'nearby'), 0)::int AS waypoints
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
         AND r.title ILIKE '%' || $1 || '%'
       ORDER BY r.title
       LIMIT 20`,
      [parsed.data.q],
    );
    // Места ищутся тем же запросом: человек в поле не обязан знать, чем у нас
    // числится «Вилючинский перевал» — маршрутом или точкой.
    const { rows: places } = await pool.query(
      `SELECT p.id::text AS id, p.name, p.location_type,
              p.lat::float8 AS lat, p.lng::float8 AS lng
       FROM places p
       WHERE p.is_visible = true AND p.merged_into_id IS NULL
         AND p.lat IS NOT NULL AND p.lng IS NOT NULL
         AND p.name ILIKE '%' || $1 || '%'
       ORDER BY p.name
       LIMIT 20`,
      [parsed.data.q],
    );

    return NextResponse.json({
      success: true,
      probe: 'field_check_routes_v2',
      total: rows.length,
      items: rows,
      places_total: places.length,
      places,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка поиска';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
