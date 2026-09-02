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
 * GET — READ-ONLY: ничего не применяет и не помечает.
 *
 * POST /api/cron/track-import-queue — применить ОДНУ запись очереди как
 * геометрию конкретного маршрута. Решение — за человеком (30.08, владелец:
 * «хочу чтобы этот трек реально стал геометрией маршрута»): цель называется
 * ЯВНО (route_id/route_title), а не берётся из matched_route_id — тот подбирает
 * ближайшую запись геометрией (POST /api/field-check/track), а не тем
 * маршрутом, который человек фактически шёл; для этого самого трека
 * matched_route_id указал на другую запись («Этническое стойбище Кайныран»),
 * хотя владелец писал именно «Зеленовские озерки» (то же имя, что уже было
 * заголовком записи в S3).
 *
 * Точки, лежащие вне Камчатки, отсеиваются той же проверкой, что уже ловит
 * «трек за пределы края» в живом следе (lib/routes/track.ts,
 * isPlausibleTrackPoint) — тот же диагноз, третье место в коде.
 *
 * Существующую geometry заменяет молча только если её источник —
 * заведомо слабее записи (`waypoints_synthetic`/`kml_inbox`/пусто), как и у
 * route-family-merge. Если там уже стоит другой настоящий трек — нужен явный
 * `force: true`, иначе один снятый трек тихо не заменит другой.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { parseTrackFile } from '@/lib/field/track-import';
import { splitAtGaps, pickSegment, describeBreak } from '@/lib/field/track-segments';
import { isPlausibleTrackPoint } from '@/lib/routes/track';

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

/** Источники, которые молча уступают настоящему треку — та же граница, что у route-family-merge. */
const WEAK_SOURCES = new Set(['waypoints_synthetic', 'kml_inbox']);

const ApplyBodySchema = z.object({
  id: z.string().uuid(),
  route_id: z.string().min(8).max(64).optional(),
  route_title: z.string().min(2).max(200).optional(),
  dry_run: z.boolean().default(true),
  force: z.boolean().default(false),
  /**
   * Какой кусок записи применять (02.09, «Зеленовские озерки»). Запись
   * рекордера режется там, где прибор молчал (track-segments): 'all' —
   * как раньше, вся линия, провалы прямыми; 'longest' — самый длинный
   * кусок; число — кусок по индексу из сухого прогона. Куски и их размеры
   * всегда печатаются в ответе — решение о куске принимает человек по ним.
   */
  segment: z.union([z.literal('all'), z.literal('longest'), z.number().int().min(0)]).default('all'),
  /**
   * Применить запись, которая уже применена, ещё раз — другим куском.
   * Без этого флага повторное применение — ошибка 409, как и было.
   */
  reapply: z.boolean().default(false),
}).refine(d => Boolean(d.route_id) !== Boolean(d.route_title), {
  message: 'Нужен ровно один из route_id / route_title — цель называется явно, matched_route_id не используется',
});

interface QueueRow {
  id: string;
  status: string;
  s3_url: string;
  format: string;
}

interface RouteRow {
  id: string;
  title: string;
  geometry_source: string | null;
}

export async function POST(request: NextRequest) {
  if (!timingSafeCompare(getCronSecret(request), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  let data: z.infer<typeof ApplyBodySchema>;
  try {
    data = ApplyBodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  const q = await pool.query<QueueRow>(
    `SELECT id::text AS id, status, s3_url, format FROM route_track_imports WHERE id::text = $1`,
    [data.id],
  );
  const queued = q.rows[0];
  if (!queued) {
    return NextResponse.json({ success: false, error: 'Запись в очереди не найдена' }, { status: 404 });
  }
  if (queued.status !== 'pending' && !(data.reapply && queued.status === 'applied')) {
    return NextResponse.json(
      { success: false, error: `Запись уже в статусе «${queued.status}» — повторно не применяем (reapply: true — только для applied)` },
      { status: 409 },
    );
  }

  const routeRes = data.route_id
    ? await pool.query<RouteRow>(
        `SELECT id::text AS id, title, geometry->>'source' AS geometry_source
         FROM kamchatka_routes WHERE id::text = $1 AND is_visible = TRUE AND merged_into_id IS NULL`,
        [data.route_id],
      )
    : await pool.query<RouteRow>(
        `SELECT id::text AS id, title, geometry->>'source' AS geometry_source
         FROM kamchatka_routes
         WHERE title ILIKE $1 AND is_visible = TRUE AND merged_into_id IS NULL`,
        [`%${data.route_title}%`],
      );
  if (routeRes.rows.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Целевой маршрут не найден — ни один видимый маршрут не подошёл' },
      { status: 404 },
    );
  }
  if (routeRes.rows.length > 1) {
    return NextResponse.json(
      {
        success: false,
        error: 'Название совпало больше чем с одним маршрутом — назовите route_id явно',
        candidates: routeRes.rows.map(r => ({ id: r.id, title: r.title })),
      },
      { status: 409 },
    );
  }
  const target = routeRes.rows[0]!;
  const targetIsStrong = target.geometry_source !== null && !WEAK_SOURCES.has(target.geometry_source);
  if (targetIsStrong && !data.force) {
    return NextResponse.json(
      {
        success: false,
        error: `У «${target.title}» уже стоит линия из источника «${target.geometry_source}» — не заменяем молча. `
          + 'Если это правда нужно — передайте force: true',
      },
      { status: 409 },
    );
  }

  // Файл — то, что реально лежит в хранилище, а не то, что запомнила очередь:
  // между загрузкой и применением файл теоретически мог исчезнуть.
  let fileBuf: Buffer;
  try {
    const res = await fetch(queued.s3_url);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Хранилище отдало ${res.status} на s3_url — файл недоступен` },
        { status: 502 },
      );
    }
    fileBuf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'сеть';
    return NextResponse.json({ success: false, error: `Не удалось скачать файл: ${message}` }, { status: 502 });
  }

  const parsed = parseTrackFile(fileBuf);
  const track = parsed.tracks.find(t => t.points.length >= 2) ?? null;
  if (!track) {
    return NextResponse.json(
      { success: false, error: 'Файл разобрался, но линии в нём больше нет', problems: parsed.problems },
      { status: 422 },
    );
  }

  // Та же проверка, что уже ловит «трек за пределы Камчатки» в живом следе
  // (breadcrumbs) — третье место в коде с тем же диагнозом (30.08).
  const plausible = track.points.filter(p => isPlausibleTrackPoint(p.lat, p.lng));
  const droppedOutOfBounds = track.points.length - plausible.length;
  if (plausible.length < 2) {
    return NextResponse.json(
      { success: false, error: 'После отсева точек за пределами Камчатки линии не осталось' },
      { status: 422 },
    );
  }

  // Разрез по провалам сигнала — ВСЕГДА считается и печатается, даже при
  // segment: 'all': человек обязан видеть, сколько кусков в записи и где
  // линия пойдёт прямой через молчание прибора.
  const segments = splitAtGaps(plausible);
  const chosen = pickSegment(segments, data.segment);
  if (!chosen || chosen.points.length < 2) {
    return NextResponse.json(
      {
        success: false,
        error: `Кусок «${String(data.segment)}» не найден или короче двух точек`,
        segments: segments.map(s => ({
          index: s.index, from: s.from, to: s.to, points: s.points.length,
          length_km: s.lengthKm, duration_s: s.durationS, break_before: describeBreak(s.breakBefore),
        })),
      },
      { status: 422 },
    );
  }
  const kept = chosen.points;
  const coords = kept.map(p => (p.ele !== null ? [p.lng, p.lat, p.ele] : [p.lng, p.lat]));
  const lengthKm = chosen.lengthKm;

  const preview = {
    target: { id: target.id, title: target.title, previous_source: target.geometry_source },
    new_line: {
      points: coords.length,
      length_km: lengthKm,
      dropped_out_of_bounds: droppedOutOfBounds,
      dropped_by_segment: plausible.length - kept.length,
      segment: data.segment,
    },
    segments: segments.map(s => ({
      index: s.index, from: s.from, to: s.to, points: s.points.length,
      length_km: s.lengthKm, duration_s: s.durationS, break_before: describeBreak(s.breakBefore),
      chosen: chosen.index === s.index,
    })),
    source_format: parsed.format,
  };

  if (data.dry_run) {
    return NextResponse.json({ success: true, dry_run: true, ...preview });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE kamchatka_routes
       SET geometry = jsonb_build_object('type', 'LineString', 'coordinates', $1::jsonb, 'source', 'gpx'),
           distance_km = $2,
           updated_at = NOW()
       WHERE id::text = $3`,
      [JSON.stringify(coords), lengthKm, target.id],
    );
    await client.query(
      `UPDATE route_track_imports SET status = 'applied' WHERE id::text = $1`,
      [data.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    const message = err instanceof Error ? err.message : 'Ошибка записи';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  } finally {
    client.release();
  }

  return NextResponse.json({ success: true, dry_run: false, applied: true, ...preview });
}
