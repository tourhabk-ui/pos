/**
 * Группа гида = предстоящие брони, назначенные ему оператором, собранные по
 * дате и туру (GET /api/guide/groups). Чистая функция — чтобы правило сборки
 * проверялось без базы.
 */
export interface AssignedRow {
  booking_id: string;
  booking_date: string;
  end_date: string | null;
  participants: number;
  booking_status: string;
  tourist_name: string | null;
  tourist_phone: string | null;
  special_requests: string | null;
  tour_id: string;
  tour_title: string;
  meeting_point: string | null;
  operator_name: string | null;
}

export interface GuideGroupBooking {
  bookingId: string;
  status: string;
  participants: number;
  touristName: string | null;
  touristPhone: string | null;
  specialRequests: string | null;
  endDate: string | null;
}

export interface GuideGroup {
  key: string;
  date: string;
  tourId: string;
  tourTitle: string;
  meetingPoint: string | null;
  operatorName: string | null;
  totalParticipants: number;
  bookings: GuideGroupBooking[];
}

export function groupAssignments(rows: AssignedRow[]): GuideGroup[] {
  const byKey = new Map<string, GuideGroup>();
  for (const r of rows) {
    const key = `${r.booking_date}:${r.tour_id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        date: r.booking_date,
        tourId: r.tour_id,
        tourTitle: r.tour_title,
        meetingPoint: r.meeting_point,
        operatorName: r.operator_name,
        totalParticipants: 0,
        bookings: [],
      };
      byKey.set(key, g);
    }
    g.totalParticipants += Number(r.participants) || 0;
    g.bookings.push({
      bookingId: r.booking_id,
      status: r.booking_status,
      participants: Number(r.participants) || 0,
      touristName: r.tourist_name,
      touristPhone: r.tourist_phone,
      specialRequests: r.special_requests,
      endDate: r.end_date,
    });
  }
  return [...byKey.values()];
}
