/**
 * Платформа за 7 дней — одна выборка для Scout-Innovator (29.10, #2767).
 *
 * До этого дня «Новых операторов: N» считалось по всем `partners`, включая
 * гидов и перевозчиков, а рядом стояло «Бронирований: 0» — и читалось как
 * «операторы есть, спроса нет». Разрыв между регистрацией и витриной был
 * невидим: тур нового оператора до витрины часто не доходит (черновик, не
 * включён), и броней у него быть не может.
 *
 * 30.10 (#2881, #2882, слово владельца «бери логирование») к числам добавлены
 * две разбивки, без которых агент гадал:
 *  - невидимые туры — ПО ПРИЧИНЕ, какой её знает шлюз витрины: черновик (не
 *    опубликован), выключен оператором, и то и другое. Других причин у шлюза
 *    нет: тур без цены, дат или линии маршрута турист ВИДИТ (это пробелы
 *    готовности, их считает channel-readiness), и называть их причиной
 *    невидимости было бы выдумкой. Три ведра в сумме равны `tours_hidden` по
 *    построению — третье определено как «невидим и не попал в первые два»;
 *  - воронка брони за 7 дней: касаний формы (маяк), заявок отправлено и
 *    отказов (сервер, lib/funnel/record) с самой частой причиной словами.
 *
 * Правила:
 *  - «виден на витрине» — одно правило с настоящей витриной, `publicTourSql`
 *    (CLAUDE.md: второй список обязательных полей — второе правило);
 *  - оператор — `partners.category = 'operator'`, не всякий партнёр;
 *  - свои заходы (`is_self`) в воронке не считаются, как у людей на /traffic;
 *  - запрос не выполнился — «не прочиталась», а не нули (§4.0): ноль броней
 *    при упавшей базе — выдумка, по которой агент сочинит находку.
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql, hiddenTourReasonSql } from '@/lib/tours/public-visibility';
import { BOOKING_REJECT_REASON_RU, type BookingRejectReason } from '@/lib/funnel/steps';

export interface PlatformWeekStats {
  bookings_week: number;
  confirmed_week: number;
  /** Операторов, зарегистрированных за 7 дней. */
  operators_new: number;
  /** Из них с хотя бы одним туром на витрине. */
  operators_new_with_visible_tour: number;
  /** Всего операторов с туром на витрине. */
  operators_with_visible_tour: number;
  tours_visible: number;
  /** Не удалённые туры, которых турист не видит (черновик или выключен). */
  tours_hidden: number;
  /** Из невидимых: включён, но не опубликован (черновик оператора). */
  hidden_draft: number;
  /** Из невидимых: опубликован, но выключен оператором. */
  hidden_inactive: number;
  /** Из невидимых: остальные — выключен и не опубликован, либо флаг не записан. */
  hidden_both: number;
  /**
   * Туры на витрине по линии маршрута (#2896, #2903): привязанный маршрут
   * (operator_tours.route_id -> kamchatka_routes) с линией, маршрут без линии
   * (турист откроет тур в поле и карты пути не получит), маршрута нет вовсе.
   * Сумма трёх равна tours_visible по построению: третье ведро — остаток.
   */
  visible_with_line: number;
  visible_route_no_line: number;
  visible_no_route: number;
  /** Воронка брони за 7 дней без своих заходов: касаний формы (маяк). */
  funnel_booking_start: number;
  /** Заявок заведено (сервер, все двери). */
  funnel_booking_submitted: number;
  /** Попыток отклонено (сервер). */
  funnel_booking_rejected: number;
  /**
   * Касаний формы, после которых тот же посетитель (суточный хэш) по тому же
   * туру не отправил заявку и не получил отказа — ушёл молча (#2899). Только
   * касания с хэшем: без него сопоставить касание с заявкой нечем, и считать
   * такое касание брошенным было бы выдумкой.
   */
  funnel_booking_abandoned: number;
  /** Касаний без хэша посетителя — их судьба неизвестна, в «брошенные» не идут. */
  funnel_booking_start_unmatched: number;
  /** Самая частая причина отказа — код словаря или null, если отказов не было. */
  funnel_top_reject_reason: string | null;
  /** Сколько раз встретилась самая частая причина. */
  funnel_top_reject_count: number;
}

export type PlatformWeekRead =
  | { kind: 'ok'; stats: PlatformWeekStats }
  | { kind: 'failed'; reason: string };

const WEEK = `NOW() - '7 days'::interval`;
const HIDDEN = `ot.deleted_at IS NULL AND NOT ${publicTourSql('ot')}`;
// Причины — из модуля шлюза: семантика флагов у них одна (public-visibility).
const { draft: DRAFT, inactive: INACTIVE } = hiddenTourReasonSql('ot');
const FUNNEL_WEEK = `FROM funnel_events WHERE is_self = FALSE AND created_at > ${WEEK}`;

export const PLATFORM_WEEK_SQL = `
WITH ops AS (
  SELECT p.id,
         p.created_at > ${WEEK} AS is_new,
         EXISTS (SELECT 1 FROM operator_tours ot WHERE ot.operator_id = p.id AND ${publicTourSql('ot')}) AS has_visible
    FROM partners p
   WHERE p.category = 'operator'
),
top_reject AS (
  SELECT reason, COUNT(*)::int AS n
    ${FUNNEL_WEEK} AND step = 'booking_rejected' AND reason IS NOT NULL
   GROUP BY reason ORDER BY n DESC, reason LIMIT 1
)
SELECT
  (SELECT COUNT(*) FROM operator_bookings WHERE deleted_at IS NULL AND created_at > ${WEEK})::int AS bookings_week,
  (SELECT COUNT(*) FROM operator_bookings WHERE deleted_at IS NULL AND created_at > ${WEEK} AND booking_status = 'confirmed')::int AS confirmed_week,
  (SELECT COUNT(*) FROM ops WHERE is_new)::int AS operators_new,
  (SELECT COUNT(*) FROM ops WHERE is_new AND has_visible)::int AS operators_new_with_visible_tour,
  (SELECT COUNT(*) FROM ops WHERE has_visible)::int AS operators_with_visible_tour,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ${publicTourSql('ot')})::int AS tours_visible,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ${HIDDEN})::int AS tours_hidden,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ${HIDDEN} AND ${DRAFT})::int AS hidden_draft,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ${HIDDEN} AND ${INACTIVE})::int AS hidden_inactive,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ${HIDDEN} AND NOT ${DRAFT} AND NOT ${INACTIVE})::int AS hidden_both,
  (SELECT COUNT(*) FROM operator_tours ot JOIN kamchatka_routes kr ON kr.id = ot.route_id
     WHERE ${publicTourSql('ot')} AND kr.geometry IS NOT NULL)::int AS visible_with_line,
  (SELECT COUNT(*) FROM operator_tours ot JOIN kamchatka_routes kr ON kr.id = ot.route_id
     WHERE ${publicTourSql('ot')} AND kr.geometry IS NULL)::int AS visible_route_no_line,
  (SELECT COUNT(*) FROM operator_tours ot
     WHERE ${publicTourSql('ot')}
       AND NOT EXISTS (SELECT 1 FROM kamchatka_routes kr WHERE kr.id = ot.route_id))::int AS visible_no_route,
  (SELECT COUNT(*) ${FUNNEL_WEEK} AND step = 'booking_start')::int AS funnel_booking_start,
  (SELECT COUNT(*) ${FUNNEL_WEEK} AND step = 'booking_submitted')::int AS funnel_booking_submitted,
  (SELECT COUNT(*) ${FUNNEL_WEEK} AND step = 'booking_rejected')::int AS funnel_booking_rejected,
  (SELECT COUNT(*) FROM funnel_events bs
     WHERE bs.is_self = FALSE AND bs.created_at > ${WEEK} AND bs.step = 'booking_start'
       AND bs.visitor_hash IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM funnel_events fe
          WHERE fe.step IN ('booking_submitted', 'booking_rejected')
            AND fe.visitor_hash = bs.visitor_hash
            AND fe.entity_id IS NOT DISTINCT FROM bs.entity_id
            AND fe.created_at >= bs.created_at
       ))::int AS funnel_booking_abandoned,
  (SELECT COUNT(*) ${FUNNEL_WEEK} AND step = 'booking_start' AND visitor_hash IS NULL)::int AS funnel_booking_start_unmatched,
  (SELECT reason FROM top_reject) AS funnel_top_reject_reason,
  COALESCE((SELECT n FROM top_reject), 0)::int AS funnel_top_reject_count
`;

export async function loadPlatformWeekStats(db: Pick<typeof pool, 'query'> = pool): Promise<PlatformWeekRead> {
  try {
    const { rows } = await db.query<PlatformWeekStats>(PLATFORM_WEEK_SQL);
    if (!rows[0]) return { kind: 'failed', reason: 'запрос вернул пусто' };
    return { kind: 'ok', stats: rows[0] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const reason = `sqlstate=${err?.code ?? 'нет'} ${err?.message ?? String(e)}`;
    console.error('[platform-week-stats] статистика платформы не прочитана:', reason);
    return { kind: 'failed', reason };
  }
}

/** Причина отказа словами; незнакомый код — как есть, не выдумывая перевода. */
export function rejectReasonWords(code: string | null): string | null {
  if (code === null) return null;
  return (BOOKING_REJECT_REASON_RU as Record<string, string>)[code as BookingRejectReason] ?? code;
}

/** «не видны туристу 12: черновики 7, выключены оператором 4, и то и другое 1». */
export function hiddenBreakdownWords(s: PlatformWeekStats): string {
  if (s.tours_hidden === 0) return 'не видны туристу 0';
  return `не видны туристу ${s.tours_hidden}: черновики ${s.hidden_draft}, выключены оператором ${s.hidden_inactive}, и то и другое ${s.hidden_both}`;
}

/** «из них с линией маршрута 50, маршрут без линии 8, без маршрута 20». */
export function lineBreakdownWords(s: PlatformWeekStats): string {
  if (s.tours_visible === 0) return '';
  return `из них с линией маршрута ${s.visible_with_line}, маршрут без линии ${s.visible_route_no_line}, без маршрута ${s.visible_no_route}`;
}

function withLine(s: PlatformWeekStats): string {
  const w = lineBreakdownWords(s);
  return w ? ` (${w})` : '';
}

/** Воронка брони одной строкой; без отказов — без «чаще всего». */
export function funnelWords(s: PlatformWeekStats): string {
  const top = s.funnel_top_reject_reason !== null && s.funnel_top_reject_count > 0
    ? ` (чаще всего: ${rejectReasonWords(s.funnel_top_reject_reason)} ×${s.funnel_top_reject_count})`
    : '';
  const unmatched = s.funnel_booking_start_unmatched > 0
    ? ` (ещё ${s.funnel_booking_start_unmatched} касаний без метки посетителя — исход неизвестен)`
    : '';
  const abandoned = s.funnel_booking_start > 0
    ? `, ушли без заявки ${s.funnel_booking_abandoned}${unmatched}`
    : '';
  return `касаний формы ${s.funnel_booking_start}, заявок отправлено ${s.funnel_booking_submitted}, отказов ${s.funnel_booking_rejected}${top}${abandoned}`;
}

/** Строки для промпта агента: цифры — или честное «не прочиталась». */
export function platformWeekPromptLines(read: PlatformWeekRead): string[] {
  if (read.kind === 'failed') {
    return [`- статистика платформы не прочиталась (${read.reason}); цифр нет, выводов из «нуля» не делать`];
  }
  const s = read.stats;
  return [
    `- Бронирований за 7 дней: ${s.bookings_week}, из них подтверждено ${s.confirmed_week}`,
    `- Новых операторов: ${s.operators_new}, из них с туром на витрине: ${s.operators_new_with_visible_tour}`,
    `- Операторов с туром на витрине всего: ${s.operators_with_visible_tour}; туров на витрине ${s.tours_visible}${withLine(s)}, ${hiddenBreakdownWords(s)}`,
    `- Воронка брони за 7 дней: ${funnelWords(s)}`,
  ];
}

/** Строка для Telegram-дайджеста. */
export function platformWeekLine(read: PlatformWeekRead): string {
  if (read.kind === 'failed') return '<b>Платформа за 7 дней:</b> статистика не прочиталась';
  const s = read.stats;
  return `<b>Платформа за 7 дней:</b> ${s.bookings_week} бронирований, ${s.confirmed_week} подтверждено, `
    + `${s.operators_new} новых операторов (с туром на витрине: ${s.operators_new_with_visible_tour}), `
    + `туров на витрине ${s.tours_visible}${withLine(s)}, ${hiddenBreakdownWords(s)}; воронка: ${funnelWords(s)}`;
}
