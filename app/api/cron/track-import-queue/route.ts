/**
 * GET /api/cron/track-import-queue — очередь загруженных треков. ЧТЕНИЕ.
 *
 * `route_track_imports` (миграция 904) писала POST /api/field-check/track и
 * не читал НИКТО: ни один файл в репозитории не делал по ней SELECT. Ровно
 * та болезнь, которую field-check-queue уже лечил для `route_field_checks`
 * («форма, чей результат нельзя посмотреть, — это не форма, а способ
 * потерять чужой труд») — 904 моложе 898 и унаследовала её заново.
 *
 * Обнаружено 24.08: владелец спросил, сняли ли знакомые трек в поле, и
 * ответить было нечем — не потому что треков нет, а потому что смотреть
 * было некуда.
 *
 * READ-ONLY: ничего не применяет и не помечает. Решение — за человеком.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Row {
  id: string;
  source_name: string | null;
  format: string;
  s3_url: string;
  byte_size: number;
  points: number | null;
  length_km: string | null;
  span_km: string | null;
  ele_share: string | null;
  step_min_m: number | null;
  step_median_m: number | null;
  step_max_m: number | null;
  timespan_min: number | null;
  waypoints: number;
  matched_route_id: string | null;
  matched_route_title: string | null;
  off_by_km: string | null;
  problems: string[] | null;
  note: string | null;
  trip_tag: string | null;
  status: string;
  created_at: string;
}

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET(request: NextRequest) {
  if (!timingSafeCompare(getCronSecret(request), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const statusRaw = (sp.get('status') ?? 'pending').trim();
  const status = ['pending', 'applied', 'rejected', 'all'].includes(statusRaw)
    ? statusRaw : 'pending';
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 40;

  try {
    const { rows } = await pool.query<Row>(
      `SELECT t.id::text AS id, t.source_name, t.format, t.s3_url, t.byte_size,
              t.points, t.length_km::text AS length_km, t.span_km::text AS span_km,
              t.ele_share::text AS ele_share,
              t.step_min_m, t.step_median_m, t.step_max_m, t.timespan_min, t.waypoints,
              t.matched_route_id::text AS matched_route_id, r.title AS matched_route_title,
              t.off_by_km::text AS off_by_km,
              t.problems, t.note, t.trip_tag, t.status, t.created_at::text AS created_at
       FROM route_track_imports t
       LEFT JOIN kamchatka_routes r ON r.id = t.matched_route_id
       WHERE ($1 = 'all' OR t.status = $1)
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [status, limit],
    );

    const items = rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      status: r.status,
      trip_tag: r.trip_tag,
      note: r.note,
      source_name: r.source_name,
      format: r.format,
      s3_url: r.s3_url,
      byte_kb: Math.round(r.byte_size / 1024),
      points: r.points,
      length_km: num(r.length_km),
      span_km: num(r.span_km),
      ele_share: num(r.ele_share),
      step_m: { min: r.step_min_m, median: r.step_median_m, max: r.step_max_m },
      timespan_min: r.timespan_min,
      waypoints: r.waypoints,
      // `matched_route_id` не пуст, а заголовка нет — маршрут слили/скрыли
      // между загрузкой и разбором; это другое «нет», чем «не нашли».
      matched_route: r.matched_route_id
        ? { id: r.matched_route_id, title: r.matched_route_title, off_by_km: num(r.off_by_km) }
        : null,
      problems: r.problems ?? [],
    }));

    return NextResponse.json({
      success: true,
      probe: 'track_import_queue_v1',
      status,
      total: items.length,
      matched: items.filter(i => i.matched_route !== null).length,
      unmatched: items.filter(i => i.matched_route === null).length,
      with_problems: items.filter(i => i.problems.length > 0).length,
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения очереди';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
