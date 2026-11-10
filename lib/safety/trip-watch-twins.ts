/**
 * Двойники контроля выхода с формы `/register` — счёт, без записи.
 *
 * До 10.11 форма слала два запроса подряд, и каждый создавал свою запись
 * (docs/safety/MCHS_PLAN.md, С1). Человек получал ссылку «Я вернулся» только
 * на первую; вторая оставалась открытой, и после срока сторож поднимал по ней
 * тревогу контакту и дежурному. Починка закрывает дверь, но не говорит,
 * сколько таких пар уже лежит в базе, — это и считает перепись.
 *
 * Двойник — запись с формы с тем же руководителем, контактом, маршрутом и
 * датами, созданная вслед за первой в пределах окна. Наружу — только числа:
 * ни имён, ни телефонов, ни номеров записей (номер записи — ключ ссылки
 * возвращения, а журнал прогонов читают посторонние).
 */

export const TWIN_WINDOW_SECONDS_DEFAULT = 120;
export const TWIN_WINDOW_SECONDS_MAX = 3600;

/** Окно из запроса: целое число секунд от 1 до часа; иное — `null`, а не умолчание молча. */
export function twinWindowSeconds(raw: string | null): number | null {
  if (raw === null || raw === '') return TWIN_WINDOW_SECONDS_DEFAULT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= TWIN_WINDOW_SECONDS_MAX ? n : null;
}

/**
 * $1 — окно в секундах, $2 — «сейчас».
 *
 * `twin_due` — срок записи, как его читает сторож: названное время возврата,
 * иначе конец последнего дня. Здесь это прикидка для счёта «срок прошёл», а не
 * правило тревоги: лестницу считает только `checkin-escalation`.
 */
export const TRIP_WATCH_TWINS_SQL = `
  WITH f AS (
    SELECT id, leader_phone, emergency_contact_phone, route_name, start_date, end_date,
           created_at, completed_at, closed_reason, expected_return_at,
           -- Всё остальное, что человек ввёл, одной строкой: совпало и оно —
           -- это двойник дефекта, а не исправленная повторная отправка.
           -- Пустое поле — своей меткой: concat_ws пропускает NULL, и «нет описания,
           -- есть почта» совпало бы с «есть описание, нет почты».
           md5(concat_ws('|',
             coalesce(route_description, '∅'), region, group_size::text, coalesce(group_members::text, '∅'),
             leader_name, coalesce(leader_email, '∅'), emergency_contact_name,
             coalesce(emergency_contact_relation, '∅'), coalesce(emergency_contact_telegram_chat_id::text, '∅'),
             coalesce(emergency_contact_email, '∅'), coalesce(emergency_contact_consent::text, '∅'),
             coalesce(expected_return_at::text, '∅'), coalesce(trip_kind, '∅'))) AS rest
      FROM route_registrations
     WHERE source = 'form'
  ), pairs AS (
    SELECT b.id                AS twin_id,
           a.completed_at      AS first_closed,
           a.closed_reason     AS first_reason,
           (a.rest = b.rest)   AS identical,
           b.completed_at      AS twin_closed,
           b.created_at        AS twin_created,
           COALESCE(b.expected_return_at, (b.end_date + 1)::timestamptz) AS twin_due
      FROM f a
      JOIN f b
        ON b.leader_phone = a.leader_phone
       AND b.emergency_contact_phone = a.emergency_contact_phone
       AND b.route_name = a.route_name
       AND b.start_date = a.start_date
       AND b.end_date = a.end_date
       AND b.created_at > a.created_at
       AND b.created_at <= a.created_at + make_interval(secs => $1::int)
  )
  SELECT
    (SELECT count(*)::int FROM f)                                             AS form_total,
    (SELECT count(*)::int FROM f WHERE completed_at IS NULL)                  AS form_open,
    count(*)::int                                                             AS pairs,
    count(DISTINCT twin_id)::int                                              AS twin_rows,
    count(DISTINCT twin_id) FILTER (WHERE identical)::int                     AS twin_identical,
    count(DISTINCT twin_id) FILTER (WHERE identical AND twin_closed IS NULL)::int AS twin_identical_open,
    count(DISTINCT twin_id) FILTER (
      WHERE twin_closed IS NOT NULL AND first_closed IS NULL)::int            AS first_open_twin_closed,
    count(DISTINCT twin_id) FILTER (WHERE twin_closed IS NULL)::int           AS twin_open,
    count(DISTINCT twin_id) FILTER (
      WHERE twin_closed IS NULL AND first_closed IS NOT NULL)::int            AS twin_open_first_closed,
    count(DISTINCT twin_id) FILTER (
      WHERE twin_closed IS NULL AND first_reason = 'returned')::int           AS twin_open_first_returned,
    count(DISTINCT twin_id) FILTER (
      WHERE twin_closed IS NULL AND twin_due < $2::timestamptz)::int          AS twin_open_overdue,
    count(DISTINCT twin_id) FILTER (WHERE EXISTS (
      SELECT 1 FROM route_registration_notifications n
       WHERE n.registration_id = twin_id AND n.status = 'sent'))::int         AS twin_alerted,
    to_char(min(twin_created) AT TIME ZONE 'UTC', 'YYYY-MM-DD')               AS first_twin_day,
    to_char(max(twin_created) AT TIME ZONE 'UTC', 'YYYY-MM-DD')               AS last_twin_day
  FROM pairs`;

export interface TripWatchTwinsReport {
  /** Записей с формы всего и открытых — знаменатель. */
  form_total: number;
  form_open: number;
  /** Пар «первая — двойник» и самих двойников (тройка даёт больше пар, чем строк). */
  pairs: number;
  twin_rows: number;
  /**
   * Двойник совпал с первой записью во ВСЁМ, что ввёл человек, — так выглядит
   * пара старого дефекта. Остальные двойники — исправленная повторная
   * отправка: закрывать их вместе с первой нельзя, это разные записи.
   *
   * После миграции 1417 такая пара бывает и законной: те же данные прислал
   * другой отправитель (второе устройство, форма без ключа повтора) — сервер
   * намеренно пишет ему свою запись. Перепись их не различает, поэтому по её
   * числам записи, созданные после выката волны 0, не закрывают.
   */
  twin_identical: number;
  twin_identical_open: number;
  /** Двойник закрыт, а первая запись открыта: человек отметился по второй ссылке. */
  first_open_twin_closed: number;
  /** Двойник открыт: по нему сторож ещё может поднять тревогу. */
  twin_open: number;
  /** Двойник открыт, а первая запись уже закрыта — человек считает, что отметился. */
  twin_open_first_closed: number;
  /** То же, и первая закрыта словом «вернулся». */
  twin_open_first_returned: number;
  /** Открытый двойник с прошедшим сроком. */
  twin_open_overdue: number;
  /** Двойники, по которым хоть одна тревога уже ушла. */
  twin_alerted: number;
  first_twin_day: string | null;
  last_twin_day: string | null;
}

const NUMERIC_KEYS = [
  'form_total', 'form_open', 'pairs', 'twin_rows', 'twin_identical', 'twin_identical_open',
  'first_open_twin_closed', 'twin_open',
  'twin_open_first_closed', 'twin_open_first_returned', 'twin_open_overdue', 'twin_alerted',
] as const;

/**
 * Строка базы → отчёт. Нет строки или число не число — `null`: «не смог
 * посчитать» не выдаётся за «двойников нет» (§4.0).
 */
export function twinsReportFromRow(row: Record<string, unknown> | undefined): TripWatchTwinsReport | null {
  if (!row) return null;
  const out: Record<string, number | string | null> = {};
  for (const key of NUMERIC_KEYS) {
    const v = row[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[key] = v;
  }
  const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  out.first_twin_day = day(row.first_twin_day);
  out.last_twin_day = day(row.last_twin_day);
  return out as unknown as TripWatchTwinsReport;
}

/** Одна строка словами — для того, кто читает журнал прогона. */
export function twinsVerdict(r: TripWatchTwinsReport): string {
  if (r.form_total === 0) return 'Записей с формы нет — двойникам неоткуда взяться.';
  if (r.twin_rows === 0) return `Двойников нет: записей с формы ${r.form_total}, пар в окне не найдено.`;
  return (
    `Двойников ${r.twin_rows} на ${r.form_total} записей с формы (слово в слово — ${r.twin_identical}, ` +
    `из них открытых ${r.twin_identical_open}); открытых — ${r.twin_open}, ` +
    `из них при закрытой первой записи — ${r.twin_open_first_closed}, с прошедшим сроком — ${r.twin_open_overdue}; ` +
    `первая открыта при закрытом двойнике — ${r.first_open_twin_closed}; тревога уже уходила по ${r.twin_alerted}.`
  );
}
