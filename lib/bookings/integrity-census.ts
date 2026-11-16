/**
 * lib/bookings/integrity-census.ts — перепись нарушений целостности броней и
 * заявок в текущих данных (#3388 п.3, шаг 1: «существующие данные сначала
 * проверить на нарушения, только отчётом»).
 *
 * Зачем до ограничений. Ограничение ставится NOT VALID, затем VALIDATE (как
 * 1291). Если в базе есть строка, которая правило нарушает, VALIDATE падает,
 * файл миграции откатывается, и накат останавливается на нём — вместе со
 * всеми миграциями после. Поэтому сначала числа, потом ограничение, и каждое
 * правило ставится, только когда его счёт на проде равен нулю.
 *
 * Только чтение и только числа: репозиторий публичный, а ответ переписи
 * печатается в логе проверки прода. Имён, телефонов, почт и id людей в ответе
 * нет. Есть имена ограничений и индексов — это схема, не данные.
 *
 * Какие правила считаются (по задаче #3388 п.3):
 *  - число людей больше нуля; взрослые и дети в сумме равны числу людей;
 *  - дата тура не раньше дня создания брони и не дальше двух лет вперёд;
 *    дата окончания не раньше даты начала;
 *  - отменённая бронь не возвращается в работу. Истории статусов у брони нет,
 *    поэтому улика — `cancelled_at` у брони, которая сейчас не `cancelled`;
 *  - повторная бронь того же тура на ту же дату тем же человеком среди
 *    действующих. Рядом — сколько дат, где у тура несколько действующих броней
 *    разных людей: это нормально для групповых туров, и уникальный индекс «тур
 *    + дата» без человека запретил бы вторую группу. Число нужно, чтобы это
 *    решение принималось по данным;
 *  - согласие на обработку ПД записано у брони и у заявки.
 *
 * Отказ замера — в `failed` с SQLSTATE, остальные замеры отвечают (§4.0):
 * «не смогли спросить» не равно «нарушений нет».
 */

/** Действующая бронь: занимает место и ждёт тура. */
export const ACTIVE_BOOKING_STATUSES = ['new', 'confirmed', 'pending_payment'] as const;

const ACTIVE_SQL = `booking_status IN (${ACTIVE_BOOKING_STATUSES.map((s) => `'${s}'`).join(', ')})`;

/**
 * Человек брони: аккаунт, иначе почта, иначе цифры телефона. Ни одного —
 * бронь считается отдельным человеком (по своему id), чтобы две анонимные
 * брони не сошлись в «повтор».
 */
const PERSON_KEY_SQL = `COALESCE(
  user_id::text,
  NULLIF(lower(btrim(tourist_email)), ''),
  NULLIF(regexp_replace(COALESCE(tourist_phone, ''), '\\D', '', 'g'), ''),
  'id:' || id::text)`;

/** Счётчики по броням. `created_at` — timestamp без пояса; сутки запаса покрывают разницу поясов. */
export const BOOKING_RULES_SQL = `
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND ${ACTIVE_SQL})::int AS active,
         COUNT(*) FILTER (WHERE participants <= 0)::int AS participants_not_positive,
         COUNT(*) FILTER (WHERE adult_count IS NOT NULL AND child_count IS NOT NULL
                            AND adult_count + child_count <> participants)::int AS parts_mismatch,
         COUNT(*) FILTER (WHERE adult_count < 0 OR child_count < 0)::int AS parts_negative,
         COUNT(*) FILTER (WHERE booking_date < created_at::date - 1)::int AS date_before_creation,
         COUNT(*) FILTER (WHERE booking_date > created_at::date + 730)::int AS date_beyond_two_years,
         COUNT(*) FILTER (WHERE end_date IS NOT NULL AND end_date < booking_date)::int AS end_before_start,
         COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL AND booking_status <> 'cancelled')::int AS cancelled_then_active,
         COUNT(*) FILTER (WHERE booking_status = 'cancelled' AND cancelled_at IS NULL)::int AS cancelled_without_time,
         COUNT(*) FILTER (WHERE pd_consent_at IS NULL)::int AS without_consent,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND ${ACTIVE_SQL} AND pd_consent_at IS NULL)::int AS active_without_consent
    FROM operator_bookings`;

/** Повтор: тот же тур, та же дата, тот же человек, обе действующие. */
export const BOOKING_REPEATS_SQL = `
  SELECT COUNT(*)::int AS groups, COALESCE(SUM(n), 0)::int AS rows
    FROM (SELECT COUNT(*) AS n
            FROM operator_bookings
           WHERE deleted_at IS NULL AND ${ACTIVE_SQL}
           GROUP BY operator_tour_id, booking_date, ${PERSON_KEY_SQL}
          HAVING COUNT(*) > 1) d`;

/** Несколько действующих броней разных людей на один тур и дату — обычное дело группового тура. */
export const BOOKING_SHARED_DATES_SQL = `
  SELECT COUNT(*)::int AS dates, COALESCE(MAX(people), 0)::int AS max_people_on_date
    FROM (SELECT COUNT(DISTINCT ${PERSON_KEY_SQL}) AS people
            FROM operator_bookings
           WHERE deleted_at IS NULL AND ${ACTIVE_SQL}
           GROUP BY operator_tour_id, booking_date
          HAVING COUNT(DISTINCT ${PERSON_KEY_SQL}) > 1) d`;

/** Бронь, у тура которой стоит отметка удаления. Внешний ключ этого не ловит: строка тура есть. */
export const BOOKING_TOUR_GONE_SQL = `
  SELECT COUNT(*)::int AS on_deleted_tour,
         COUNT(*) FILTER (WHERE ob.deleted_at IS NULL AND ob.${ACTIVE_SQL})::int AS active_on_deleted_tour
    FROM operator_bookings ob
    JOIN operator_tours t ON t.id = ob.operator_tour_id
   WHERE t.deleted_at IS NOT NULL`;

/** Заявки: сколько, сколько отменено клиентом и сколько без записанного согласия. */
export const LEAD_RULES_SQL = `
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_by_client,
         COUNT(*) FILTER (WHERE pd_consent_at IS NULL)::int AS without_consent,
         COUNT(*) FILTER (WHERE pd_consent_at IS NULL AND is_self IS NOT TRUE)::int AS without_consent_not_self,
         COUNT(*) FILTER (WHERE group_size IS NOT NULL AND group_size <= 0)::int AS group_size_not_positive
    FROM leads`;

/** Что база уже держит на двух таблицах: ограничения, уникальные индексы, триггеры. */
export const GUARDS_SQL = `
  SELECT rel.relname::text AS table_name, 'constraint' AS kind,
         c.conname::text AS name, c.contype::text AS type, c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public' AND rel.relname IN ('operator_bookings', 'leads')
     AND c.contype IN ('c', 'u', 'f', 'x')
  UNION ALL
  SELECT t.relname::text, 'unique_index', i.relname::text, 'u', TRUE
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname IN ('operator_bookings', 'leads')
     AND x.indisunique AND NOT x.indisprimary
  UNION ALL
  SELECT rel.relname::text, 'trigger', tg.tgname::text, 't', TRUE
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public' AND rel.relname IN ('operator_bookings', 'leads')
     AND NOT tg.tgisinternal
   ORDER BY 1, 2, 3`;

export type IntegrityMeasure = 'booking_rules' | 'booking_repeats' | 'booking_shared_dates'
  | 'booking_tour_gone' | 'lead_rules' | 'guards';

export const INTEGRITY_MEASURES: ReadonlyArray<readonly [IntegrityMeasure, string]> = [
  ['booking_rules', BOOKING_RULES_SQL],
  ['booking_repeats', BOOKING_REPEATS_SQL],
  ['booking_shared_dates', BOOKING_SHARED_DATES_SQL],
  ['booking_tour_gone', BOOKING_TOUR_GONE_SQL],
  ['lead_rules', LEAD_RULES_SQL],
  ['guards', GUARDS_SQL],
];

type Row = Record<string, unknown>;

export interface IntegrityFailure { measure: IntegrityMeasure; sqlstate: string | null }

/**
 * Правило, которое можно ставить ограничением сейчас: нарушений ноль. `null`
 * — счёт не получен, и сказать «можно» нельзя.
 */
function readyIf(n: unknown): boolean | null {
  return typeof n === 'number' ? n === 0 : null;
}

/** Ответ переписи из строк замеров; не полученный замер — `null`, а не нули. */
export function assembleIntegrityCensus(
  got: Partial<Record<IntegrityMeasure, Row[]>>,
  failed: IntegrityFailure[],
  checkedAt: string,
) {
  const rules = got.booking_rules?.[0] ?? null;
  const repeats = got.booking_repeats?.[0] ?? null;
  const shared = got.booking_shared_dates?.[0] ?? null;
  const tourGone = got.booking_tour_gone?.[0] ?? null;
  const leads = got.lead_rules?.[0] ?? null;
  const guards = got.guards ?? null;

  const byTable = (table: string) => guards === null ? null : guards
    .filter((g) => g.table_name === table)
    .map((g) => ({ kind: g.kind, name: g.name, type: g.type, validated: g.validated }));

  return {
    ok: failed.length === 0,
    probe: 'booking_integrity_census_v1',
    checked_at: checkedAt,
    active_statuses: ACTIVE_BOOKING_STATUSES,
    bookings: rules,
    booking_repeats: repeats,
    booking_shared_dates: shared,
    booking_tour_gone: tourGone,
    leads,
    // Можно ли ставить ограничение сейчас: нарушений ноль. null — счёт не получен.
    constraint_ready: {
      participants_positive: readyIf(rules?.participants_not_positive),
      parts_sum: readyIf(rules?.parts_mismatch),
      parts_not_negative: readyIf(rules?.parts_negative),
      date_not_before_creation: readyIf(rules?.date_before_creation),
      date_within_two_years: readyIf(rules?.date_beyond_two_years),
      end_not_before_start: readyIf(rules?.end_before_start),
      cancelled_stays_cancelled: readyIf(rules?.cancelled_then_active),
      no_repeat_same_person: readyIf(repeats?.groups),
      lead_group_size_positive: readyIf(leads?.group_size_not_positive),
    },
    existing_guards: {
      operator_bookings: byTable('operator_bookings'),
      leads: byTable('leads'),
    },
    failed,
  };
}
