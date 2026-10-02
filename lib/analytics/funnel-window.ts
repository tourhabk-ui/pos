/**
 * lib/analytics/funnel-window.ts — воронка за ОКНО: за день, за вчера, за
 * неделю, за произвольные сутки. Одно место, где она считается.
 *
 * ── Зачем (владелец 29.09: «хочу смотреть не только аналитику за 7 дней, но и
 * за день») ────────────────────────────────────────────────────────────────
 *
 * Воронка считалась только крон-переписью (`/api/cron/funnel-census?days=N`) —
 * скользящее окно в целых сутках, закрытое секретом крона. Владелец её не
 * видел вовсе: на странице `/hub/admin/traffic` были «сегодня / 7 / 30»
 * суммарно и ряд посещений по дням, но не шаги воронки (визит → просмотр тура
 * → начало брони → заявка → бронь → оплата) и не разбивка этих шагов по дням.
 *
 * Теперь и перепись, и админ-страница спрашивают ЭТОТ модуль. Два места, где
 * считается одно и то же, разошлись бы на первом же изменении окна (§12).
 *
 * ── Сутки — камчатские ────────────────────────────────────────────────────
 *
 * «Сегодня» владельца — камчатское сегодня: UTC+12 без перехода на летнее
 * время (отменён в 2011), поэтому смещение постоянное. База и сервер живут в
 * других поясах (сессия БД — МСК, Node — UTC), и суточная граница по
 * `CURRENT_DATE` делила бы день человека на два: вечерние просмотры
 * попадали бы в «завтра».
 *
 * ── Что значат числа (честность подсчёта) ─────────────────────────────────
 *
 * `visits` — по суточному `visitor_hash` (в нём дата, 152-ФЗ, длинный профиль
 * не строится). На окне из одних суток это люди; на окне из нескольких —
 * СУММА человеко-дней, а не «разные люди»: тот же человек в два дня даст два.
 * Модуль отдаёт `visitor_unit`, чтобы экран назвал единицу словом.
 *
 * ── Третье состояние (§4.0) ───────────────────────────────────────────────
 *
 * Каждый замер отвечает числом ИЛИ «не смог», и это разные вещи. Упавший
 * запрос не превращается в ноль: ноль визитов — факт о туристах, отказ
 * запроса — факт о нас. Поэтому все счётчики `number | null`, вердикт
 * выносится только по полностью известным входам, а «сутки ещё не кончились»
 * названо отдельным признаком (`partial`).
 */

import { pool } from '@/lib/db-pool';
import { pickFunnelFinding, funnelSampleShortfall, type FunnelCounts } from '@/lib/agents/evo/growth-agent';
import {
  DAY_MS, KAMCHATKA_TIMEZONE_LABEL,
  isRealDate, kamchatkaDate, kamchatkaDayStart, ruShort, shiftDate,
} from '@/lib/analytics/kamchatka-day';

// Прежние имена доступны отсюда же: сторожа и вызывающие читают их у воронки.
export { KAMCHATKA_TIMEZONE_LABEL, KAMCHATKA_UTC_OFFSET_HOURS, kamchatkaDate, kamchatkaDayStart, ruShort, shiftDate } from '@/lib/analytics/kamchatka-day';

// ── Окно ─────────────────────────────────────────────────────────────────

export const FUNNEL_RANGES = ['today', 'yesterday', '7d', '30d'] as const;
export type FunnelRange = (typeof FUNNEL_RANGES)[number];

const DEFAULT_DAYS = 7;
export const MAX_WINDOW_DAYS = 90;

export interface FunnelWindow {
  /** День целиком (или сегодня до сих пор) либо скользящее окно из N суток. */
  kind: 'day' | 'rolling';
  /** Нижняя граница, включительно. */
  from: Date;
  /** Верхняя, НЕ включительно; null — «до сих пор». */
  to: Date | null;
  /** Камчатская дата для kind === 'day'. */
  date: string | null;
  /** Длина скользящего окна в сутках. */
  days: number | null;
  /** Сутки ещё не закончились — цифры будут расти. */
  partial: boolean;
  label: string;
  /** Единица «визитов»: на одних сутках это люди, на многих — человеко-дни. */
  visitor_unit: 'people' | 'visitor_days';
}

export type ResolvedWindow =
  | { ok: true; window: FunnelWindow }
  | { ok: false; error: string };

export interface WindowInput {
  range?: string | null;
  date?: string | null;
  days?: number | string | null;
}

function dayWindow(date: string, now: Date): FunnelWindow {
  const today = kamchatkaDate(now);
  const from = kamchatkaDayStart(date);
  const isToday = date === today;
  const yesterday = shiftDate(today, -1);
  const name = isToday ? 'Сегодня' : date === yesterday ? 'Вчера' : null;
  return {
    kind: 'day',
    from,
    to: isToday ? null : new Date(from.getTime() + DAY_MS),
    date,
    days: null,
    partial: isToday,
    label: `${name ? `${name}, ` : ''}${ruShort(date)} (сутки по Камчатке)`,
    visitor_unit: 'people',
  };
}

function rollingWindow(days: number, now: Date): FunnelWindow {
  return {
    kind: 'rolling',
    from: new Date(now.getTime() - days * DAY_MS),
    to: null,
    date: null,
    days,
    partial: false,
    label: days === 1 ? 'Последние 24 часа' : `Последние ${days} дн.`,
    visitor_unit: days === 1 ? 'people' : 'visitor_days',
  };
}

/**
 * Что просит человек → границы окна. Ровно одно из `range` / `date` / `days`;
 * ничего — семь суток (прежнее поведение переписи).
 *
 * Будущая дата и несуществующая — ошибка со словами, а не пустое окно: пустой
 * день читался бы как «в тот день никто не заходил».
 */
export function resolveFunnelWindow(input: WindowInput, now: Date = new Date()): ResolvedWindow {
  const range = input.range || null;
  const date = input.date || null;
  const daysRaw = input.days === undefined || input.days === null || input.days === '' ? null : input.days;

  const given = [range, date, daysRaw].filter((v) => v !== null).length;
  if (given > 1) return { ok: false, error: 'Укажите что-то одно: range, date или days.' };

  if (range) {
    if (!(FUNNEL_RANGES as readonly string[]).includes(range)) {
      return { ok: false, error: `Неизвестный период «${range}». Допустимы: ${FUNNEL_RANGES.join(', ')}.` };
    }
    const today = kamchatkaDate(now);
    if (range === 'today') return { ok: true, window: dayWindow(today, now) };
    if (range === 'yesterday') return { ok: true, window: dayWindow(shiftDate(today, -1), now) };
    return { ok: true, window: rollingWindow(range === '7d' ? 7 : 30, now) };
  }

  if (date) {
    if (!isRealDate(date)) return { ok: false, error: `«${date}» — не дата в формате ГГГГ-ММ-ДД.` };
    if (date > kamchatkaDate(now)) return { ok: false, error: `«${date}» ещё не наступило по Камчатке.` };
    return { ok: true, window: dayWindow(date, now) };
  }

  if (daysRaw !== null) {
    const n = Number(daysRaw);
    if (!Number.isFinite(n)) return { ok: false, error: `days «${String(daysRaw)}» — не число.` };
    return { ok: true, window: rollingWindow(Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(n))), now) };
  }

  return { ok: true, window: rollingWindow(DEFAULT_DAYS, now) };
}

/** Параметры SQL для окна: `$1` — нижняя граница, `$2` — верхняя или NULL. */
export function windowParams(w: FunnelWindow): [string, string | null] {
  return [w.from.toISOString(), w.to ? w.to.toISOString() : null];
}

/**
 * Условие окна на колонку `created_at` единственной таблицы запроса.
 *
 * Границы параметризованы и приведены явно: `$2` бывает NULL, и без
 * `::timestamptz` сервер не выведет его тип (42P08 — тот же класс, что стоил
 * воронке маяка полтора месяца, CLAUDE.md §4). Нижняя граница включительно,
 * верхняя — нет: сутки не пересекаются и не теряют полночь.
 */
export const WINDOW_SQL =
  `created_at >= $1::timestamptz AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)`;

// ── Замеры ───────────────────────────────────────────────────────────────

/**
 * Кто исполняет запросы. По умолчанию — общий пул; интеграционный тест
 * подставляет свой на отдельной базе (тот же приём, что у честной цены), чтобы
 * судить ТОТ ЖЕ код на настоящем PostgreSQL, а не его копию.
 */
export type FunnelExecutor = Pick<typeof pool, 'query'>;

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
    console.error(`[funnel-window] замер «${name}» не удался:`, msg);
    return { value: null, failed: msg };
  }
}

/**
 * Вердикт — только по полностью известным входам.
 *
 * Дыра воронки определяется ПЕРВЫМ нулём сверху. Если верхний счётчик не
 * сосчитался, «первый ноль» окажется ниже него — и мы назовём сломанным
 * звено, которое просто следующее по списку. Неизвестность хотя бы одного
 * входа отменяет вердикт целиком.
 */
export function verdictFrom(
  counts: Partial<Record<keyof FunnelCounts, number | null>>,
): {
  verdict: ReturnType<typeof pickFunnelFinding>;
  unknown: string[];
  /** Выборки не хватило, чтобы судить — причина словами (иначе null). */
  insufficient: string | null;
} {
  const required: (keyof FunnelCounts)[] = [
    'visits', 'tour_views', 'booking_starts', 'leads', 'bookings', 'paid',
  ];
  const unknown = required.filter((k) => counts[k] === null || counts[k] === undefined);
  if (unknown.length > 0) return { verdict: null, unknown, insufficient: null };

  const full: FunnelCounts = {
    visits:         counts.visits as number,
    tour_views:     counts.tour_views as number,
    booking_starts: counts.booking_starts as number,
    leads:          counts.leads as number,
    bookings:       counts.bookings as number,
    paid:           counts.paid as number,
    plan_views:     counts.plan_views ?? 0,
    plan_to_tour:   counts.plan_to_tour ?? 0,
  };

  return {
    verdict: pickFunnelFinding(full),
    unknown: [],
    // Пустой вердикт бывает двух разных родов: «поток есть» и «наблюдений
    // слишком мало, чтобы судить». Второй — третий исход §4.0.
    insufficient: funnelSampleShortfall(full),
  };
}

const TOUR_PATH = `(path LIKE '/catalog/tours/%' OR path LIKE '/marketplace/tours/%')`;

/**
 * Отчёт воронки за окно. Форма ответа — прежняя форма переписи, чтобы её
 * читатели (проба прода, эволюция) не заметили переезда, плюс `window`.
 */
export async function buildFunnelReport(w: FunnelWindow, exec: FunnelExecutor = pool) {
  const startedAt = Date.now();
  const p = windowParams(w);

  const [
    views, starts, leadRows, bookingRows,
    viewsAlive, beaconAlive, topPaths, tourEdges, leadStatuses, leadSources, bookingStatuses,
  ] = await Promise.all([
    // Верх воронки — собственная метрика. Пути обеих публичных карточек тура:
    // /catalog и /marketplace рендерят одну реализацию (§11).
    measure('page_views', async () => (await exec.query<{
      visits: number; tour_views: number; plan_views: number; plan_to_tour: number; bot_views: number;
    }>(
      `SELECT COUNT(DISTINCT visitor_hash) FILTER (WHERE is_bot = FALSE AND is_self = FALSE)::int AS visits,
              COUNT(*) FILTER (WHERE is_bot = FALSE AND is_self = FALSE AND ${TOUR_PATH})::int AS tour_views,
              COUNT(*) FILTER (WHERE is_bot = FALSE AND is_self = FALSE
                                 AND (path LIKE '/trip/%' OR path LIKE '/plans/%'))::int AS plan_views,
              COUNT(*) FILTER (WHERE is_bot = FALSE AND is_self = FALSE AND ${TOUR_PATH}
                                 AND (from_path LIKE '/trip/%' OR from_path LIKE '/plans/%'))::int AS plan_to_tour,
              COUNT(*) FILTER (WHERE is_bot = TRUE)::int AS bot_views
         FROM page_views
        WHERE ${WINDOW_SQL}`,
      p,
    )).rows[0]),

    measure('funnel_events.booking_start', async () => (await exec.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM funnel_events
        WHERE step = 'booking_start' AND is_self = FALSE AND ${WINDOW_SQL}`,
      p,
    )).rows[0]?.n ?? 0),

    measure('leads', async () => (await exec.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM leads WHERE ${WINDOW_SQL}`,
      p,
    )).rows[0]?.n ?? 0),

    measure('operator_bookings', async () => (await exec.query<{ bookings: number; paid: number }>(
      `SELECT COUNT(*)::int AS bookings, COUNT(paid_at)::int AS paid
         FROM operator_bookings WHERE ${WINDOW_SQL}`,
      p,
    )).rows[0]),

    // Жив ли счётчик вообще: «на сайт не заходят» и «метрика умерла» дают
    // одинаковый ноль в окне и разные последние строки за всё время.
    measure('page_views.alive', async () => (await exec.query<{ last_at: string | null; total: number }>(
      `SELECT MAX(created_at)::text AS last_at, COUNT(*)::int AS total FROM page_views`,
    )).rows[0]),

    // То же для маяка: ноль касаний формы и неработающий маяк — разные вещи.
    measure('funnel_events.alive', async () => (await exec.query<{ last_at: string | null; total: number }>(
      `SELECT MAX(created_at)::text AS last_at, COUNT(*)::int AS total FROM funnel_events`,
    )).rows[0]),

    // Куда люди на самом деле ходят. Без этого «каталог не ведёт к турам» —
    // догадка: может, до каталога никто и не доходил.
    measure('top_paths', async () => (await exec.query<{ path: string; views: number; visitors: number }>(
      `SELECT path,
              COUNT(*)::int                     AS views,
              COUNT(DISTINCT visitor_hash)::int AS visitors
         FROM page_views
        WHERE ${WINDOW_SQL} AND is_bot = FALSE AND is_self = FALSE
        GROUP BY path
        ORDER BY views DESC
        LIMIT 20`,
      p,
    )).rows),

    // Откуда приходят В карточку тура: какая поверхность кормит коммерцию.
    measure('tour_edges', async () => (await exec.query<{ from_path: string | null; views: number }>(
      // from_path — переход внутри приложения; его нет у прямой загрузки.
      // Тогда источник — внешний referrer по хосту (панель 02.10: 11 из 12
      // заходов в карточку тура читались как «без источника», хотя у части
      // был внешний хост — Telegram, поиск). Свой хост при прямой загрузке —
      // «внутри сайта (перезагрузка)». Пусто — честное «без источника».
      `SELECT COALESCE(
                from_path,
                CASE
                  WHEN referrer IS NULL OR referrer = '' THEN NULL
                  WHEN substring(referrer from '^[a-z]+://([^/]+)') LIKE '%vedarai.ru' THEN 'внутри сайта (прямая загрузка)'
                  ELSE 'внешний: ' || substring(referrer from '^[a-z]+://([^/]+)')
                END
              ) AS from_path,
              COUNT(*)::int AS views
         FROM page_views
        WHERE ${WINDOW_SQL} AND is_bot = FALSE AND is_self = FALSE AND ${TOUR_PATH}
        GROUP BY 1
        ORDER BY views DESC
        LIMIT 15`,
      p,
    )).rows),

    measure('leads_by_status', async () => (await exec.query<{ status: string | null; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM leads
        WHERE ${WINDOW_SQL} GROUP BY status ORDER BY n DESC`,
      p,
    )).rows),

    // Откуда заявки: одна заявка мимо «начали бронь» — это другой вход (Кузьмич,
    // подбор, MCP), а не дыра воронки. Без источника это вывод, с ним — число (02.10).
    measure('leads_by_source', async () => (await exec.query<{ source: string; n: number }>(
      `SELECT COALESCE(NULLIF(source_channel, ''), NULLIF(source_url, ''), 'не записан') AS source, COUNT(*)::int AS n
         FROM leads WHERE ${WINDOW_SQL} GROUP BY 1 ORDER BY n DESC LIMIT 12`,
      p,
    )).rows),

    measure('bookings_by_status', async () => (await exec.query<{ booking_status: string | null; n: number }>(
      `SELECT booking_status, COUNT(*)::int AS n FROM operator_bookings
        WHERE ${WINDOW_SQL} GROUP BY booking_status ORDER BY n DESC`,
      p,
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

  const { verdict, unknown, insufficient } = verdictFrom(counts);

  const measures: Array<[string, Measured<unknown>]> = [
    ['page_views', views], ['booking_start', starts], ['leads', leadRows],
    ['operator_bookings', bookingRows], ['page_views.alive', viewsAlive],
    ['funnel_events.alive', beaconAlive], ['top_paths', topPaths],
    ['tour_edges', tourEdges], ['leads_by_status', leadStatuses],
    ['leads_by_source', leadSources], ['bookings_by_status', bookingStatuses],
  ];
  const failed = measures.filter(([, m]) => m.failed !== null);

  return {
    window: {
      kind: w.kind,
      label: w.label,
      from: w.from.toISOString(),
      to: w.to ? w.to.toISOString() : null,
      date: w.date,
      days: w.days,
      partial: w.partial,
      visitor_unit: w.visitor_unit,
      timezone: KAMCHATKA_TIMEZONE_LABEL,
    },
    window_days: w.days,
    counts,
    bot_views: views.value?.bot_views ?? null,
    // Вердикт — от того же судьи, что в петле эволюции.
    verdict: verdict
      ? { title: verdict.title, severity: verdict.severity, suggestion: verdict.suggestion }
      : null,
    // Три разных ответа: «поток есть» (no_broken_link), «не смог проверить»
    // (unknown) и «судить рано» (insufficient_sample; на одних сутках это
    // норма, а не тревога).
    verdict_state: unknown.length > 0
      ? 'unknown'
      : (verdict ? 'broken_link' : (insufficient ? 'insufficient_sample' : 'no_broken_link')),
    unknown_inputs: unknown,
    insufficient_sample: insufficient,
    failed_measures: failed.map(([name, m]) => ({ measure: name, error: m.failed })),
    liveness: {
      views_last_at:     viewsAlive.value?.last_at ?? null,
      views_rows_total:  viewsAlive.value?.total ?? null,
      beacon_last_at:    beaconAlive.value?.last_at ?? null,
      beacon_rows_total: beaconAlive.value?.total ?? null,
    },
    top_paths:          topPaths.value,
    tour_entry_edges:   tourEdges.value,
    leads_by_status:    leadStatuses.value,
    leads_by_source:    leadSources.value,
    bookings_by_status: bookingStatuses.value,
    // Судить не по чему — это отказ переписи, а не «всё хорошо».
    meaningful: failed.length === 0 && unknown.length === 0,
    duration_ms: Date.now() - startedAt,
  };
}

export type FunnelReport = Awaited<ReturnType<typeof buildFunnelReport>>;

// ── Разбивка по суткам ───────────────────────────────────────────────────

export interface FunnelDayRow {
  /** Камчатская дата, ГГГГ-ММ-ДД. */
  date: string;
  /** Сутки ещё идут: цифры вырастут. */
  partial: boolean;
  /** null — этот счётчик не сосчитался, а не «ноль». */
  visits: number | null;
  tour_views: number | null;
  booking_starts: number | null;
  leads: number | null;
  bookings: number | null;
  paid: number | null;
}

export const DEFAULT_DAILY_ROWS = 14;
const MAX_DAILY_ROWS = 60;

/**
 * Шаги воронки по каждым камчатским суткам, новые сверху.
 *
 * Границы суток идут в SQL массивами (`unnest ... WITH ORDINALITY`), а не
 * `date_trunc` в поясе сервера: сессия БД живёт в МСК, и «сутки» базы не
 * совпали бы с сутками владельца. Каждый источник — отдельный замер: упавший
 * не обнуляет остальные, а его ячейки становятся `null`.
 */
export async function funnelByDay(
  now: Date = new Date(),
  rows: number = DEFAULT_DAILY_ROWS,
  exec: FunnelExecutor = pool,
): Promise<{ rows: FunnelDayRow[]; failed: Array<{ measure: string; error: string }> }> {
  const n = Math.min(MAX_DAILY_ROWS, Math.max(1, Math.trunc(rows)));
  const today = kamchatkaDate(now);
  const dates = Array.from({ length: n }, (_, i) => shiftDate(today, -i));
  const starts = dates.map((d) => kamchatkaDayStart(d).toISOString());
  const ends = dates.map((d) => new Date(kamchatkaDayStart(d).getTime() + DAY_MS).toISOString());
  const p = [starts, ends];

  const FROM = `FROM unnest($1::timestamptz[], $2::timestamptz[]) WITH ORDINALITY AS d(s, e, i)`;

  const [views, bookStarts, leadRows, bookingRows] = await Promise.all([
    measure('daily.page_views', async () => (await exec.query<{ i: number; visits: number; tour_views: number }>(
      `SELECT d.i::int AS i,
              COUNT(DISTINCT pv.visitor_hash) FILTER (WHERE pv.is_bot = FALSE AND pv.is_self = FALSE)::int AS visits,
              COUNT(*) FILTER (WHERE pv.is_bot = FALSE AND pv.is_self = FALSE
                                 AND (pv.path LIKE '/catalog/tours/%' OR pv.path LIKE '/marketplace/tours/%'))::int AS tour_views
         ${FROM}
         LEFT JOIN page_views pv ON pv.created_at >= d.s AND pv.created_at < d.e
        GROUP BY d.i`,
      p,
    )).rows),
    measure('daily.booking_start', async () => (await exec.query<{ i: number; n: number }>(
      `SELECT d.i::int AS i, COUNT(fe.id)::int AS n
         ${FROM}
         LEFT JOIN funnel_events fe ON fe.step = 'booking_start' AND fe.created_at >= d.s AND fe.created_at < d.e
        GROUP BY d.i`,
      p,
    )).rows),
    measure('daily.leads', async () => (await exec.query<{ i: number; n: number }>(
      `SELECT d.i::int AS i, COUNT(l.id)::int AS n
         ${FROM}
         LEFT JOIN leads l ON l.created_at >= d.s AND l.created_at < d.e
        GROUP BY d.i`,
      p,
    )).rows),
    measure('daily.operator_bookings', async () => (await exec.query<{ i: number; bookings: number; paid: number }>(
      `SELECT d.i::int AS i, COUNT(ob.id)::int AS bookings, COUNT(ob.paid_at)::int AS paid
         ${FROM}
         LEFT JOIN operator_bookings ob ON ob.created_at >= d.s AND ob.created_at < d.e
        GROUP BY d.i`,
      p,
    )).rows),
  ]);

  const byIdx = <T extends { i: number }>(m: Measured<T[]>): Map<number, T> =>
    new Map((m.value ?? []).map((r) => [r.i, r]));
  const v = byIdx(views); const s = byIdx(bookStarts); const l = byIdx(leadRows); const b = byIdx(bookingRows);

  const out: FunnelDayRow[] = dates.map((date, idx) => {
    const i = idx + 1; // WITH ORDINALITY считает с единицы
    return {
      date,
      partial: date === today,
      // Замер удался, а строки за эти сутки нет — «не знаю», а не ноль: у
      // LEFT JOIN строка есть у каждых суток, её отсутствие — сбой разбора.
      visits:         views.failed ? null : (v.get(i)?.visits ?? null),
      tour_views:     views.failed ? null : (v.get(i)?.tour_views ?? null),
      booking_starts: bookStarts.failed ? null : (s.get(i)?.n ?? null),
      leads:          leadRows.failed ? null : (l.get(i)?.n ?? null),
      bookings:       bookingRows.failed ? null : (b.get(i)?.bookings ?? null),
      paid:           bookingRows.failed ? null : (b.get(i)?.paid ?? null),
    };
  });

  const failed = [views, bookStarts, leadRows, bookingRows]
    .map((m, k) => ({ m, name: ['daily.page_views', 'daily.booking_start', 'daily.leads', 'daily.operator_bookings'][k] }))
    .filter(({ m }) => m.failed !== null)
    .map(({ m, name }) => ({ measure: name, error: m.failed as string }));

  return { rows: out, failed };
}
