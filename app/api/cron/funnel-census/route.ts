/**
 * GET /api/cron/funnel-census?secret=<CRON_SECRET>&days=7
 *
 * Перепись воронки. Только чтение, ничего не меняет.
 *
 * ЗАЧЕМ. Разговор «где у нас дыра в воронке» упирается в цифры, которых
 * никто не видит. Три существующих среза (`/api/health/booking-funnel`,
 * `/api/health/selection-funnel`, `/api/admin/analytics/funnel`) закрыты
 * `requireAdmin` — с раннера и из переписки они недостижимы. Объектив
 * эволюции `scanFunnel` считает ровно то же, но наружу отдаёт ОДНУ находку
 * («самое верхнее сломанное звено») и молчит про сами числа: по вердикту
 * «каталог не ведёт к турам» нельзя понять, тысяча это визитов или три.
 *
 * ВЕРДИКТ НЕ СВОЙ. Звено называет `pickFunnelFinding` из
 * `lib/agents/evo/growth-agent` — тот же судья, что судит в петле эволюции.
 * Заводить здесь второе правило «что считать дырой» запрещено: два правила
 * разойдутся, и мы будем чинить не то, на что ругается петля.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0). Каждый замер отвечает числом ИЛИ «не смог», и
 * это разные вещи. Упавший запрос НЕ превращается в ноль: ноль визитов —
 * это факт о туристах, а отказ запроса — факт о нас. Поэтому:
 *   - каждый счётчик имеет тип `number | null`;
 *   - вердикт выносится, только если известны ВСЕ входы; иначе
 *     `verdict: null` и список того, что не сосчиталось;
 *   - `meaningful: false`, когда судить не по чему.
 *
 * ЧТО РАЗЛИЧАЕТ ЭТА ПЕРЕПИСЬ, А ОБЪЕКТИВ — НЕТ. Три пары состояний, которые
 * в одной цифре «0» неотличимы, а чинятся по-разному:
 *   - «визитов нет» против «ходят одни краулеры» — `bot_views` отдельно;
 *   - «форму брони не трогали» против «маяк никогда не работал» —
 *     `beacon_last_at` и `beacon_rows_total`;
 *   - «на сайт не заходят» против «счётчик просмотров умер» —
 *     `views_last_at` и `views_rows_total`.
 * Первое лечится привлечением, второе — починкой кода. Спутать их значит
 * месяц чинить не ту половину.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pickFunnelFinding, type FunnelCounts } from '@/lib/agents/evo/growth-agent';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_DAYS = 7;
const MAX_DAYS     = 90;

/** Отказ не глушится: имя замера и текст ошибки уходят в лог и в ответ. */
export interface Measured<T> {
  value: T | null;
  failed: string | null;
}

export async function measure<T>(name: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), failed: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'неизвестная ошибка';
    console.error(`[funnel-census] замер «${name}» не удался:`, msg);
    return { value: null, failed: msg };
  }
}

/**
 * Вердикт — только по полностью известным входам.
 *
 * Дыра воронки определяется ПЕРВЫМ нулём сверху. Если верхний счётчик не
 * сосчитался, «первый ноль» окажется ниже него — и мы назовём сломанным
 * звено, которое просто следующее по списку. Поэтому неизвестность хотя бы
 * одного входа отменяет вердикт целиком.
 */
export function verdictFrom(
  counts: Partial<Record<keyof FunnelCounts, number | null>>,
): { verdict: ReturnType<typeof pickFunnelFinding>; unknown: string[] } {
  const required: (keyof FunnelCounts)[] = [
    'visits', 'tour_views', 'booking_starts', 'leads', 'bookings', 'paid',
  ];
  const unknown = required.filter((k) => counts[k] === null || counts[k] === undefined);
  if (unknown.length > 0) return { verdict: null, unknown };

  return {
    verdict: pickFunnelFinding({
      visits:         counts.visits as number,
      tour_views:     counts.tour_views as number,
      booking_starts: counts.booking_starts as number,
      leads:          counts.leads as number,
      bookings:       counts.bookings as number,
      paid:           counts.paid as number,
      plan_views:     counts.plan_views ?? 0,
      plan_to_tour:   counts.plan_to_tour ?? 0,
    }),
    unknown: [],
  };
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const rawDays = Number(req.nextUrl.searchParams.get('days') ?? DEFAULT_DAYS);
  const days = Number.isFinite(rawDays)
    ? Math.min(MAX_DAYS, Math.max(1, Math.trunc(rawDays)))
    : DEFAULT_DAYS;

  // Окно параметризовано, не склеено строкой (§4, сторож sql-interval-not-concatenated).
  const W = `NOW() - ($1 || ' days')::INTERVAL`;

  const [
    views, starts, leadRows, bookingRows,
    viewsAlive, beaconAlive, topPaths, tourEdges, leadStatuses, bookingStatuses,
  ] = await Promise.all([
    // Верх воронки — собственная метрика. Пути обеих публичных карточек тура:
    // /catalog и /marketplace рендерят одну реализацию (§11).
    measure('page_views', async () => (await pool.query<{
      visits: number; tour_views: number; plan_views: number; plan_to_tour: number; bot_views: number;
    }>(
      `SELECT COUNT(DISTINCT visitor_hash) FILTER (WHERE is_bot = FALSE)::int AS visits,
              COUNT(*) FILTER (WHERE is_bot = FALSE
                                 AND (path LIKE '/catalog/tours/%' OR path LIKE '/marketplace/tours/%'))::int AS tour_views,
              COUNT(*) FILTER (WHERE is_bot = FALSE
                                 AND (path LIKE '/trip/%' OR path LIKE '/plans/%'))::int AS plan_views,
              COUNT(*) FILTER (WHERE is_bot = FALSE
                                 AND (path LIKE '/catalog/tours/%' OR path LIKE '/marketplace/tours/%')
                                 AND (from_path LIKE '/trip/%' OR from_path LIKE '/plans/%'))::int AS plan_to_tour,
              COUNT(*) FILTER (WHERE is_bot = TRUE)::int AS bot_views
         FROM page_views
        WHERE created_at > ${W}`,
      [days],
    )).rows[0]),

    measure('funnel_events.booking_start', async () => (await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM funnel_events
        WHERE step = 'booking_start' AND created_at > ${W}`,
      [days],
    )).rows[0]?.n ?? 0),

    measure('leads', async () => (await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM leads WHERE created_at > ${W}`,
      [days],
    )).rows[0]?.n ?? 0),

    measure('operator_bookings', async () => (await pool.query<{ bookings: number; paid: number }>(
      `SELECT COUNT(*)::int AS bookings, COUNT(paid_at)::int AS paid
         FROM operator_bookings WHERE created_at > ${W}`,
      [days],
    )).rows[0]),

    // Жив ли счётчик вообще: «на сайт не заходят» и «метрика умерла» дают
    // одинаковый ноль в окне и разные последние строки за всё время.
    measure('page_views.alive', async () => (await pool.query<{ last_at: string | null; total: number }>(
      `SELECT MAX(created_at)::text AS last_at, COUNT(*)::int AS total FROM page_views`,
    )).rows[0]),

    // То же для маяка: ноль касаний формы и неработающий маяк — разные вещи.
    measure('funnel_events.alive', async () => (await pool.query<{ last_at: string | null; total: number }>(
      `SELECT MAX(created_at)::text AS last_at, COUNT(*)::int AS total FROM funnel_events`,
    )).rows[0]),

    // Куда люди на самом деле ходят. Без этого «каталог не ведёт к турам» —
    // догадка: может, до каталога никто и не доходил.
    measure('top_paths', async () => (await pool.query<{ path: string; views: number; visitors: number }>(
      `SELECT path,
              COUNT(*)::int                     AS views,
              COUNT(DISTINCT visitor_hash)::int AS visitors
         FROM page_views
        WHERE created_at > ${W} AND is_bot = FALSE
        GROUP BY path
        ORDER BY views DESC
        LIMIT 20`,
      [days],
    )).rows),

    // Откуда приходят В карточку тура. Это и есть ответ, какая поверхность
    // кормит коммерцию, а какая только кажется, что кормит.
    measure('tour_edges', async () => (await pool.query<{ from_path: string | null; views: number }>(
      `SELECT from_path, COUNT(*)::int AS views
         FROM page_views
        WHERE created_at > ${W} AND is_bot = FALSE
          AND (path LIKE '/catalog/tours/%' OR path LIKE '/marketplace/tours/%')
        GROUP BY from_path
        ORDER BY views DESC
        LIMIT 15`,
      [days],
    )).rows),

    measure('leads_by_status', async () => (await pool.query<{ status: string | null; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM leads
        WHERE created_at > ${W} GROUP BY status ORDER BY n DESC`,
      [days],
    )).rows),

    measure('bookings_by_status', async () => (await pool.query<{ booking_status: string | null; n: number }>(
      `SELECT booking_status, COUNT(*)::int AS n FROM operator_bookings
        WHERE created_at > ${W} GROUP BY booking_status ORDER BY n DESC`,
      [days],
    )).rows),
  ]);

  const counts = {
    visits:         views.value?.visits ?? null,
    tour_views:     views.value?.tour_views ?? null,
    booking_starts: starts.value ?? null,
    leads:          leadRows.value ?? null,
    bookings:       bookingRows.value?.bookings ?? null,
    paid:           bookingRows.value?.paid ?? null,
    plan_views:     views.value?.plan_views ?? null,
    plan_to_tour:   views.value?.plan_to_tour ?? null,
  };

  const { verdict, unknown } = verdictFrom(counts);

  const failures = [
    views, starts, leadRows, bookingRows,
    viewsAlive, beaconAlive, topPaths, tourEdges, leadStatuses, bookingStatuses,
  ].filter((m) => m.failed !== null).length;

  return NextResponse.json({
    ok: true,
    probe: 'funnel_census_v1',
    window_days: days,
    counts,
    bot_views: views.value?.bot_views ?? null,
    // Вердикт — от того же судьи, что в петле эволюции.
    verdict: verdict
      ? { title: verdict.title, severity: verdict.severity, suggestion: verdict.suggestion }
      : null,
    // Пустой вердикт при известных входах — «поток до денег есть»; при
    // неизвестных — «не смог проверить». Это разные ответы, и они названы.
    verdict_state: unknown.length > 0 ? 'unknown' : (verdict ? 'broken_link' : 'no_broken_link'),
    unknown_inputs: unknown,
    failed_measures: [
      ['page_views', views], ['booking_start', starts], ['leads', leadRows],
      ['operator_bookings', bookingRows], ['page_views.alive', viewsAlive],
      ['funnel_events.alive', beaconAlive], ['top_paths', topPaths],
      ['tour_edges', tourEdges], ['leads_by_status', leadStatuses],
      ['bookings_by_status', bookingStatuses],
    ].filter(([, m]) => (m as Measured<unknown>).failed !== null)
     .map(([name, m]) => ({ measure: name, error: (m as Measured<unknown>).failed })),
    liveness: {
      views_last_at:     viewsAlive.value?.last_at ?? null,
      views_rows_total:  viewsAlive.value?.total ?? null,
      beacon_last_at:    beaconAlive.value?.last_at ?? null,
      beacon_rows_total: beaconAlive.value?.total ?? null,
    },
    top_paths:          topPaths.value,
    tour_entry_edges:   tourEdges.value,
    leads_by_status:    leadStatuses.value,
    bookings_by_status: bookingStatuses.value,
    // Судить не по чему — это отказ переписи, а не «всё хорошо».
    meaningful: failures === 0 && unknown.length === 0,
    duration_ms: Date.now() - startedAt,
  });
}
