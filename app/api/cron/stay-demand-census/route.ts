/**
 * GET /api/cron/stay-demand-census?days=30 (Authorization: Bearer <CRON_SECRET>)
 *
 * Перепись спроса на жильё. Только чтение, ничего не меняет.
 *
 * ЗАЧЕМ (решение владельца 29.09). Подключение к TravelLine как канал продаж
 * стоит 100 000 ₽ разово и минимум 200 000 ₽ в год — при нуле продаж тоже.
 * Платить это имеет смысл, когда видно, что жильё у нас ищут. Эта перепись и
 * есть то число: сколько людей смотрят жильё, сколько ищут с условиями, что
 * находят, сколько начинают бронь и сколько раз Кузьмич и MCP спрашивают
 * витрину.
 *
 * ВЕРДИКТА «ПОДКЛЮЧАТЬ / НЕТ» ЗДЕСЬ НЕТ НАМЕРЕННО. Порог окупаемости зависит
 * от комиссии, которую даст отель по прямому договору, а её никто не называл.
 * Выдумать процент, чтобы вынести приговор, — ровно то, что запрещает §4.0.
 * Перепись отдаёт факты; решение — за владельцем.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0). Каждый замер — число ИЛИ «не смог». И отдельно:
 * счётчик поисков заведён 29.09, до первой его строки ноль значит «не
 * считали», а не «не искали». Поэтому в ответе `counting_since` — дата
 * первого события; окно, начатое раньше неё, так и помечается.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { summarizeStaySearches, type StaySearchRow } from '@/lib/stay/demand';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_DAYS = 30;
const MAX_DAYS     = 90;

interface Measured<T> {
  value: T | null;
  failed: string | null;
}

/** Отказ не глушится: имя замера и текст ошибки уходят в лог и в ответ. */
async function measure<T>(name: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), failed: null };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(`[stay-demand-census] замер «${name}» не удался:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return { value: null, failed: e?.message ?? 'неизвестная ошибка' };
  }
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

  const [supply, views, searchRows, webDays, starts, external, mcp, bookings, since] = await Promise.all([
    // Предложение: без него спрос не с чем сравнить. «Ищут, а витрина пуста»
    // и «ищут и находят» — разные доводы в разговоре о поставщике.
    measure('supply', async () => (await pool.query<{ listings: number; rooms: number }>(
      `SELECT COUNT(DISTINCT a.id)::int AS listings,
              COUNT(r.id)::int          AS rooms
         FROM accommodations a
         LEFT JOIN accommodation_rooms r ON r.accommodation_id = a.id AND r.is_active = true
        WHERE ${publicAccommodationSql('a')}`,
    )).rows[0]),

    // Просмотры — собственная метрика (page_views), люди отдельно от ботов.
    measure('page_views', async () => (await pool.query<{
      list_views: number; list_visitor_days: number;
      card_views: number; card_visitor_days: number; bot_views: number;
    }>(
      `SELECT COUNT(*) FILTER (WHERE is_bot = FALSE AND is_self = FALSE AND path = '/accommodations')::int AS list_views,
              COUNT(DISTINCT visitor_hash) FILTER (WHERE is_bot = FALSE AND is_self = FALSE AND path = '/accommodations')::int AS list_visitor_days,
              COUNT(*) FILTER (WHERE is_bot = FALSE AND is_self = FALSE AND path LIKE '/accommodations/%')::int AS card_views,
              COUNT(DISTINCT visitor_hash) FILTER (WHERE is_bot = FALSE AND is_self = FALSE AND path LIKE '/accommodations/%')::int AS card_visitor_days,
              COUNT(*) FILTER (WHERE is_bot = TRUE)::int AS bot_views
         FROM page_views
        WHERE created_at > ${W}
          AND (path = '/accommodations' OR path LIKE '/accommodations/%')`,
      [days],
    )).rows[0]),

    measure('stay_search', async () => (await pool.query<StaySearchRow>(
      `SELECT entity_id, COUNT(*)::int AS searches
         FROM funnel_events
        WHERE step = 'stay_search' AND created_at > ${W} AND is_self = FALSE
        GROUP BY entity_id`,
      [days],
    )).rows),

    // Один посетитель, искавший в каталоге дважды с разным исходом, — один
    // человеко-день, а не два: считается отдельным DISTINCT по всему каналу,
    // а не суммой по исходам.
    measure('stay_search_web_days', async () => (await pool.query<{ visitor_days: number }>(
      `SELECT COUNT(DISTINCT visitor_hash)::int AS visitor_days
         FROM funnel_events
        WHERE step = 'stay_search' AND entity_id LIKE 'web:%' AND created_at > ${W} AND is_self = FALSE`,
      [days],
    )).rows[0]),

    measure('stay_booking_start', async () => (await pool.query<{
      starts: number; visitor_days: number; listings: number;
    }>(
      `SELECT COUNT(*)::int                     AS starts,
              COUNT(DISTINCT visitor_hash)::int AS visitor_days,
              COUNT(DISTINCT entity_id)::int    AS listings
         FROM funnel_events
        WHERE step = 'stay_booking_start' AND created_at > ${W} AND is_self = FALSE`,
      [days],
    )).rows[0]),

    // Переходы на бронь на сайте самого объекта (миграция 1109): спрос,
    // который ушёл к объекту напрямую, мимо нашей брони. Без этого счёта
    // «брони у нас нет» читалось бы как «жильё не нужно».
    measure('stay_external_booking', async () => (await pool.query<{ clicks: number; visitor_days: number; listings: number }>(
      `SELECT COUNT(*)::int                     AS clicks,
              COUNT(DISTINCT visitor_hash)::int AS visitor_days,
              COUNT(DISTINCT entity_id)::int    AS listings
         FROM funnel_events
        WHERE step = 'stay_external_booking' AND created_at > ${W} AND is_self = FALSE`,
      [days],
    )).rows[0]),

    // MCP пишет свой журнал вызовов независимо от счётчика поисков — это
    // доля внешних AI-агентов внутри канала 'agent', не вычитаемая из него.
    measure('mcp_tool_calls', async () => (await pool.query<{ calls: number; ok: number; callers: number }>(
      `SELECT COUNT(*)::int                    AS calls,
              COUNT(*) FILTER (WHERE ok)::int  AS ok,
              COUNT(DISTINCT caller_hash)::int AS callers
         FROM mcp_tool_calls
        WHERE tool = 'search_accommodations' AND created_at > ${W}`,
      [days],
    )).rows[0]),

    measure('accommodation_bookings', async () => (await pool.query<{ status: string | null; n: number }>(
      `SELECT status, COUNT(*)::int AS n
         FROM accommodation_bookings
        WHERE created_at > ${W}
        GROUP BY status
        ORDER BY n DESC`,
      [days],
    )).rows),

    // С какого момента счётчик вообще пишет: до первой строки ноль — «не
    // считали», а не «не искали».
    measure('counting_since', async () => (await pool.query<{ first_at: string | null; total: number }>(
      `SELECT MIN(created_at)::text AS first_at, COUNT(*)::int AS total
         FROM funnel_events
        WHERE step IN ('stay_search', 'stay_booking_start', 'stay_external_booking')`,
    )).rows[0]),
  ]);

  const searches = searchRows.value ? summarizeStaySearches(searchRows.value) : null;
  const windowStart = new Date(Date.now() - days * 86_400_000);
  const firstAt = since.value?.first_at ? new Date(since.value.first_at) : null;

  const all: [string, Measured<unknown>][] = [
    ['supply', supply], ['page_views', views], ['stay_search', searchRows], ['stay_search_web_days', webDays],
    ['stay_booking_start', starts], ['stay_external_booking', external], ['mcp_tool_calls', mcp],
    ['accommodation_bookings', bookings], ['counting_since', since],
  ];
  const failed = all.filter(([, m]) => m.failed !== null);

  return NextResponse.json({
    ok: true,
    probe: 'stay_demand_census_v1',
    window_days: days,
    // Суточный хэш посетителя (152-ФЗ) не склеивает дни: «visitor_days» —
    // человеко-ДНИ, а не люди. Один человек, приходивший пять дней, — пять.
    // Число людей за окно эта метрика по построению не даёт.
    visitor_note: 'visitor_days — человеко-дни: суточный хэш не склеивает дни; людей за окно не посчитать',
    supply: supply.value ?? null,
    views: views.value ?? null,
    // Каналы: web — каталог с условиями (люди, дедуп за час); agent — Кузьмич
    // и MCP вместе (штуки, посетителя в этом месте нет).
    searches: searches?.searches ?? null,
    web_search_visitor_days: webDays.value?.visitor_days ?? null,
    unrecognized_search_events: searches?.unrecognized ?? null,
    booking_starts: starts.value ?? null,
    external_booking_clicks: external.value ?? null,
    mcp_search_calls: mcp.value ?? null,
    bookings_by_status: bookings.value ?? null,
    counting: {
      since: since.value?.first_at ?? null,
      events_total: since.value?.total ?? null,
      // Окно началось раньше первой строки счётчика — нули в начале окна
      // значат «не считали». null — не смогли узнать.
      window_predates_counter: since.value
        ? (firstAt === null ? true : windowStart < firstAt)
        : null,
    },
    failed_measures: failed.map(([name, m]) => ({ measure: name, error: m.failed })),
    // Судить не по чему — это отказ переписи, а не «спроса нет».
    meaningful: failed.length === 0,
    duration_ms: Date.now() - startedAt,
  });
}
