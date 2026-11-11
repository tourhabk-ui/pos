/**
 * Чтения календаря гида — одни для кабинета на сайте (`GET /api/guide/schedule`,
 * `GET /api/guide/groups`) и экрана «Расписание» в чате кабинета
 * (lib/guides/chat-role, слово владельца 30.10).
 *
 * Правило доступа живёт в SQL (`TEAM_SQL`, `SCHEDULE_SQL`): назначения брони —
 * только гиду действующей команды, имя и телефон туриста — только в группах
 * назначенного гида. Отказ базы — исключение: вызывающий говорит «не
 * загрузилось», а не «пусто».
 *
 * С 11.11 (#3213) расписание читает и брони своих туров гида — третьим
 * списком, без копии в guide_schedule, — и называет дни пересечения с
 * назначениями оператора.
 */

import { query } from '@/lib/database';
import { SCHEDULE_SQL, TEAM_SQL } from '@/lib/guides/team-queries';
import { mapScheduleRow, type ScheduleItem, type ScheduleRow, type ScheduleStatus } from '@/lib/guides/schedule-shape';
import { groupAssignments, type AssignedRow, type GuideGroup } from '@/lib/guides/groups';
import { findScheduleConflicts, type ScheduleConflict } from '@/lib/guides/schedule-conflicts';

export interface GuideAssignment {
  bookingId: string;
  date: string;
  /** Последний день многодневной брони; null — однодневная. */
  endDate: string | null;
  tourTitle: string;
  participants: number;
  status: string;
}

/** Бронь своего тура гида (он продавец) — без ПД туриста (#3213). */
export interface GuideOwnBooking {
  bookingId: string;
  date: string;
  endDate: string | null;
  tourTitle: string;
  participants: number;
  status: string;
}

export interface GuideSchedule {
  schedule: ScheduleItem[];
  /** Назначения оператора в тот же период — без ПД туриста. */
  assignments: GuideAssignment[];
  /** Брони своих туров гида в тот же период — без ПД туриста. */
  ownBookings: GuideOwnBooking[];
  /** Дни, где есть и назначение оператора, и бронь своего тура. */
  conflicts: ScheduleConflict[];
}

type BookingRow = {
  booking_id: string; booking_date: string; end_date: string | null;
  tour_title: string; participants: number; booking_status: string;
};

function booking(r: BookingRow): GuideAssignment {
  return {
    bookingId: r.booking_id,
    date: r.booking_date,
    endDate: r.end_date ?? null,
    tourTitle: r.tour_title,
    participants: Number(r.participants),
    status: r.booking_status,
  };
}

/**
 * Записи календаря, назначения и брони своих туров в диапазоне дат
 * включительно. Отказ любого из трёх чтений — исключение: вызывающий говорит
 * «не загрузилось», а не показывает день свободным (§4.0).
 */
export async function readGuideSchedule(
  guideId: string,
  dateFrom: string,
  dateTo: string,
  status: ScheduleStatus | null = null,
): Promise<GuideSchedule> {
  const [entries, assignments, own] = await Promise.all([
    query<ScheduleRow>(SCHEDULE_SQL.list, [guideId, dateFrom, dateTo, status]),
    query<BookingRow>(TEAM_SQL.assignedInRange, [guideId, dateFrom, dateTo]),
    query<BookingRow>(TEAM_SQL.ownToursInRange, [guideId, dateFrom, dateTo]),
  ]);
  const assigned = assignments.rows.map(booking);
  const ownBookings = own.rows.map(booking);
  return {
    schedule: entries.rows.map(mapScheduleRow),
    assignments: assigned,
    ownBookings,
    conflicts: findScheduleConflicts(assigned, ownBookings, dateFrom, dateTo),
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
