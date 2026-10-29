/**
 * Платформа за 7 дней — одна выборка для Scout-Innovator (29.10, #2767).
 *
 * До этого дня «Новых операторов: N» считалось по всем `partners`, включая
 * гидов и перевозчиков, а рядом стояло «Бронирований: 0» — и читалось как
 * «операторы есть, спроса нет». Разрыв между регистрацией и витриной был
 * невидим: тур нового оператора до витрины часто не доходит (черновик, не
 * включён), и броней у него быть не может.
 *
 * Правила:
 *  - «виден на витрине» — одно правило с настоящей витриной, `publicTourSql`
 *    (CLAUDE.md: второй список обязательных полей — второе правило);
 *  - оператор — `partners.category = 'operator'`, не всякий партнёр;
 *  - запрос не выполнился — «не прочиталась», а не нули (§4.0): ноль броней
 *    при упавшей базе — выдумка, по которой агент сочинит находку.
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';

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
}

export type PlatformWeekRead =
  | { kind: 'ok'; stats: PlatformWeekStats }
  | { kind: 'failed'; reason: string };

const WEEK = `NOW() - '7 days'::interval`;

export const PLATFORM_WEEK_SQL = `
WITH ops AS (
  SELECT p.id,
         p.created_at > ${WEEK} AS is_new,
         EXISTS (SELECT 1 FROM operator_tours ot WHERE ot.operator_id = p.id AND ${publicTourSql('ot')}) AS has_visible
    FROM partners p
   WHERE p.category = 'operator'
)
SELECT
  (SELECT COUNT(*) FROM operator_bookings WHERE deleted_at IS NULL AND created_at > ${WEEK})::int AS bookings_week,
  (SELECT COUNT(*) FROM operator_bookings WHERE deleted_at IS NULL AND created_at > ${WEEK} AND booking_status = 'confirmed')::int AS confirmed_week,
  (SELECT COUNT(*) FROM ops WHERE is_new)::int AS operators_new,
  (SELECT COUNT(*) FROM ops WHERE is_new AND has_visible)::int AS operators_new_with_visible_tour,
  (SELECT COUNT(*) FROM ops WHERE has_visible)::int AS operators_with_visible_tour,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ${publicTourSql('ot')})::int AS tours_visible,
  (SELECT COUNT(*) FROM operator_tours ot WHERE ot.deleted_at IS NULL AND NOT ${publicTourSql('ot')})::int AS tours_hidden
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

/** Строки для промпта агента: цифры — или честное «не прочиталась». */
export function platformWeekPromptLines(read: PlatformWeekRead): string[] {
  if (read.kind === 'failed') {
    return [`- статистика платформы не прочиталась (${read.reason}); цифр нет, выводов из «нуля» не делать`];
  }
  const s = read.stats;
  return [
    `- Бронирований: ${s.bookings_week} всего, ${s.confirmed_week} подтверждено`,
    `- Новых операторов: ${s.operators_new}, из них с туром на витрине: ${s.operators_new_with_visible_tour}`,
    `- Операторов с туром на витрине всего: ${s.operators_with_visible_tour}; туров на витрине ${s.tours_visible}, не видны туристу ${s.tours_hidden}`,
  ];
}

/** Строка для Telegram-дайджеста. */
export function platformWeekLine(read: PlatformWeekRead): string {
  if (read.kind === 'failed') return '<b>Платформа за 7 дней:</b> статистика не прочиталась';
  const s = read.stats;
  return `<b>Платформа за 7 дней:</b> ${s.bookings_week} бронирований, ${s.confirmed_week} подтверждено, `
    + `${s.operators_new} новых операторов (с туром на витрине: ${s.operators_new_with_visible_tour}), `
    + `туров на витрине ${s.tours_visible}, не видны ${s.tours_hidden}`;
}
