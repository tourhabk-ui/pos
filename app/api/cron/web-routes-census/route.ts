/**
 * GET /api/cron/web-routes-census — остались ли на витрине «паутины».
 *
 * Паутина — запись, чья линия соединяет прямыми разбросанные по краю точки
 * (наследие миграции 168). Турист видит «трек», которым нельзя идти:
 * полевой скрин 20.07 показывал прямую через весь Петропавловск.
 *
 * Меряем ПРЫЖОК, а не длину: у настоящего трека соседние вершины стоят
 * плотно (проложенные по графу линии — 396 и 1104 вершины на 12.9 и 64.3
 * км), у паутины один сегмент перелетает десятки километров. Поэтому
 * длинный честный маршрут в отчёт не попадёт, а короткая паутина попадёт.
 *
 * Считаем только живое: видимое и не слитое — скрытые шесть паутин
 * (миграция 868) здесь показываться не должны.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { maxSegmentKm } from '@/lib/routes/geometry-compact';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Прыжок длиннее этого — по такой линии не идут. */
const JUMP_KM = 25;
const SAMPLE_LIMIT = 40;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      id: string; title: string; coordinates: unknown; source: string | null;
    }>(
      `SELECT r.id::text AS id, r.title,
              r.geometry->'coordinates' AS coordinates,
              r.geometry->>'source' AS source
       FROM kamchatka_routes r
       WHERE r.is_visible = true
         AND r.merged_into_id IS NULL
         AND r.geometry->>'type' = 'LineString'`,
    );

    const webs: Array<{ id: string; title: string; jumpKm: number; vertices: number; source: string | null }> = [];
    let checked = 0;

    for (const r of rows) {
      const raw = Array.isArray(r.coordinates) ? r.coordinates : [];
      // GeoJSON хранит [lng, lat], детектор ждёт [lat, lng].
      const coords = raw
        .filter((c): c is number[] => Array.isArray(c) && c.length >= 2)
        .map(c => [c[1], c[0]] as [number, number]);
      if (coords.length < 2) continue;
      checked += 1;
      const jump = Math.round(maxSegmentKm(coords) * 10) / 10;
      if (jump > JUMP_KM) {
        webs.push({ id: r.id, title: r.title, jumpKm: jump, vertices: coords.length, source: r.source });
      }
    }

    webs.sort((a, b) => b.jumpKm - a.jumpKm);

    return NextResponse.json({
      success: true,
      live_with_line: checked,
      webs_found: webs.length,
      jump_threshold_km: JUMP_KM,
      webs: webs.slice(0, SAMPLE_LIMIT),
      webs_dropped: Math.max(0, webs.length - SAMPLE_LIMIT),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи паутин';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
