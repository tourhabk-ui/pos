/**
 * Форма записи календаря гида: строка guide_schedule → ответ API.
 * Общая для GET списка и GET/PUT одной записи.
 */

/** Статусы — ровно те, что держит CHECK guide_schedule_status_check. */
export const SCHEDULE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScheduleRow {
  id: string;
  tour_date: string;
  start_time: string;
  end_time: string | null;
  title: string | null;
  description: string | null;
  location_name: string | null;
  max_participants: number | null;
  participants_count: number | null;
  status: string | null;
  notes: string | null;
  operator_booking_id: string | null;
  tour_title: string | null;
  booking_status: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export function mapScheduleRow(r: ScheduleRow) {
  return {
    id: r.id,
    date: r.tour_date,
    startTime: r.start_time,
    endTime: r.end_time,
    title: r.title,
    description: r.description,
    locationName: r.location_name,
    maxParticipants: r.max_participants,
    participantsCount: r.participants_count,
    status: r.status,
    notes: r.notes,
    operatorBookingId: r.operator_booking_id,
    tourTitle: r.tour_title,
    bookingStatus: r.booking_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type ScheduleItem = ReturnType<typeof mapScheduleRow>;
