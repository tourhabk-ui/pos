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
    return NextResponse.json({
      success: true,
      probe: 'field_check_routes_v1',
      total: rows.length,
      items: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка поиска';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
