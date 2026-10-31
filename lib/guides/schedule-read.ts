/**
 * Чтения календаря гида — одни для кабинета на сайте (`GET /api/guide/schedule`,
 * `GET /api/guide/groups`) и экрана «Расписание» в чате кабинета
 * (lib/guides/chat-role, слово владельца 30.10).
 *
 * Правило доступа живёт в SQL (`TEAM_SQL`, `SCHEDULE_SQL`): назначения брони —
 * только гиду действующей команды, имя и телефон туриста — только в группах
 * назначенного гида. Отказ базы — исключение: вызывающий говорит «не
 * загрузилось», а не «пусто».
 */

import { query } from '@/lib/database';
import { SCHEDULE_SQL, TEAM_SQL } from '@/lib/guides/team-queries';
import { mapScheduleRow, type ScheduleItem, type ScheduleRow, type ScheduleStatus } from '@/lib/guides/schedule-shape';
import { groupAssignments, type AssignedRow, type GuideGroup } from '@/lib/guides/groups';

export interface GuideAssignment {
  bookingId: string;
  date: string;
  tourTitle: string;
  participants: number;
  status: string;
}

export interface GuideSchedule {
  schedule: ScheduleItem[];
  /** Назначения оператора в тот же период — без ПД туриста. */
  assignments: GuideAssignment[];
}

/** Записи календаря и назначения в диапазоне дат включительно. */
export async function readGuideSchedule(
  guideId: string,
  dateFrom: string,
  dateTo: string,
  status: ScheduleStatus | null = null,
): Promise<GuideSchedule> {
  const [entries, assignments] = await Promise.all([
    query<ScheduleRow>(SCHEDULE_SQL.list, [guideId, dateFrom, dateTo, status]),
    query<{ booking_id: string; booking_date: string; tour_title: string; participants: number; booking_status: string }>(
      TEAM_SQL.assignedInRange, [guideId, dateFrom, dateTo],
    ),
  ]);
  return {
    schedule: entries.rows.map(mapScheduleRow),
    assignments: assignments.rows.map((r) => ({
      bookingId: r.booking_id,
      date: r.booking_date,
      tourTitle: r.tour_title,
      participants: Number(r.participants),
      status: r.booking_status,
    })),
  };
}

export interface GuideGroups {
  inTeam: boolean;
  groups: GuideGroup[];
}

/** Группы гида — предстоящие назначенные брони по дате и туру (с контактом туриста). */
export async function readGuideGroups(guideId: string): Promise<GuideGroups> {
  const membership = await query<{ operator_id: string | null }>(TEAM_SQL.membership, [guideId]);
  const inTeam = Boolean(membership.rows[0]?.operator_id);
  const result = inTeam
    ? await query<AssignedRow>(TEAM_SQL.assignedUpcoming, [guideId])
    : { rows: [] as AssignedRow[] };
  return { inTeam, groups: groupAssignments(result.rows) };
}
