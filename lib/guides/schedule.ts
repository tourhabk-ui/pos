/**
 * Проверки календаря гида — с третьим исходом (§4.0).
 *
 * До 1019 здесь (тогда — в lib/auth/guide-helpers.ts) было две беды одной
 * формы. `checkScheduleConflicts` звал SQL-функцию check_schedule_conflicts,
 * которой нет в схеме, и в `catch` отвечал `false` — «конфликт есть»: каждая
 * попытка гида добавить запись получала 409 «Конфликт расписания», хотя
 * пересекаться было не с чем. `hasTourDayConflict` падал на сравнении
 * time с timestamptz и в `catch` отвечал обратное — «конфликта нет». Один
 * отказ базы выдавался за «плохо», другой за «хорошо», и ни один не
 * оставлял следа.
 *
 * Теперь у каждой проверки исхода три: 'ok' | 'conflict' | 'unknown'.
 * 'unknown' вызывающий превращает в 503 «не удалось проверить», а причина
 * с SQLSTATE уходит в лог.
 */
import { query } from '@/lib/database';
import { SCHEDULE_SQL } from '@/lib/guides/team-queries';
import { logGuideFailure } from '@/lib/guides/team';

export type ScheduleCheck = 'ok' | 'conflict' | 'unknown';
export type Ownership = 'ok' | 'denied' | 'unknown';

/** Пересекается ли интервал с другой живой записью гида в тот же день. */
export async function checkScheduleOverlap(p: {
  guideId: string;
  date: string;
  startTime: string;
  endTime: string;
  excludeId?: string | null;
}): Promise<ScheduleCheck> {
  try {
    const { rows } = await query(SCHEDULE_SQL.overlap, [
      p.guideId, p.date, p.startTime, p.endTime, p.excludeId ?? null,
    ]);
    return rows.length > 0 ? 'conflict' : 'ok';
  } catch (error) {
    logGuideFailure('schedule.overlap', error);
    return 'unknown';
  }
}

/** На одну назначенную бронь — одна живая запись календаря. */
export async function checkBookingEntryConflict(p: {
  guideId: string;
  operatorBookingId: string | null | undefined;
  excludeId?: string | null;
}): Promise<ScheduleCheck> {
  if (!p.operatorBookingId) return 'ok';
  try {
    const { rows } = await query(SCHEDULE_SQL.bookingEntryExists, [
      p.guideId, p.operatorBookingId, p.excludeId ?? null,
    ]);
    return rows.length > 0 ? 'conflict' : 'ok';
  } catch (error) {
    logGuideFailure('schedule.bookingEntry', error);
    return 'unknown';
  }
}

/** Бронь назначена этому гиду, и он сейчас в команде её оператора. */
export async function bookingAssignedToGuide(bookingId: string, guideId: string): Promise<Ownership> {
  try {
    const { rows } = await query(SCHEDULE_SQL.bookingAssignedToGuide, [bookingId, guideId]);
    return rows.length > 0 ? 'ok' : 'denied';
  } catch (error) {
    logGuideFailure('schedule.bookingAssigned', error);
    return 'unknown';
  }
}

/** Запись календаря принадлежит гиду. */
export async function scheduleOwnership(
  scheduleId: string,
  guideId: string,
): Promise<{ state: Ownership; operatorBookingId: string | null }> {
  try {
    const { rows } = await query<{ id: string; operator_booking_id: string | null }>(
      SCHEDULE_SQL.ownership, [scheduleId, guideId],
    );
    if (rows.length === 0) return { state: 'denied', operatorBookingId: null };
    return { state: 'ok', operatorBookingId: rows[0].operator_booking_id };
  } catch (error) {
    logGuideFailure('schedule.ownership', error);
    return { state: 'unknown', operatorBookingId: null };
  }
}
