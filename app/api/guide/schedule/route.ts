import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { SCHEDULE_SQL, TEAM_SQL } from '@/lib/guides/team-queries';
import { logGuideFailure } from '@/lib/guides/team';
import {
  checkScheduleOverlap, checkBookingEntryConflict, bookingAssignedToGuide,
} from '@/lib/guides/schedule';
import { mapScheduleRow, DATE_RE, TIME_RE, SCHEDULE_STATUSES, type ScheduleRow } from '@/lib/guides/schedule-shape';

export const dynamic = 'force-dynamic';

/**
 * Расписание гида — его личный календарь (guide_schedule, миграция 1019).
 *
 * Дата — `tour_date`, время — `start_time`/`end_time` типа time, местное, как
 * ввёл гид. Запись может ссылаться на бронь, на которую гида назначил
 * оператор (`operatorBookingId`), — только на СВОЮ назначенную.
 *
 * До 25.09 GET отвечал 500 всегда (uuid = bigint в соединениях с
 * operator_tours/operator_bookings, ST_X без PostGIS), а POST — 409
 * «Конфликт» всегда (несуществующая check_schedule_conflicts, отказ читался
 * как конфликт). Заодно INSERT не заполнял NOT NULL tour_date и клал ISO-время
 * в колонку time.
 */

const QuerySchema = z.object({
  dateFrom: z.string().regex(DATE_RE, 'dateFrom — дата ГГГГ-ММ-ДД'),
  dateTo: z.string().regex(DATE_RE, 'dateTo — дата ГГГГ-ММ-ДД'),
  status: z.enum(['all', ...SCHEDULE_STATUSES]).default('all'),
});

const CreateSchema = z.object({
  date: z.string().regex(DATE_RE, 'Дата — в формате ГГГГ-ММ-ДД'),
  startTime: z.string().regex(TIME_RE, 'Время начала — ЧЧ:ММ'),
  endTime: z.string().regex(TIME_RE, 'Время окончания — ЧЧ:ММ'),
  title: z.string().trim().min(1, 'Название обязательно').max(200),
  description: z.string().max(2000).optional(),
  operatorBookingId: z.string().regex(/^\d{1,18}$/, 'Некорректный номер брони').optional(),
  maxParticipants: z.number().int().positive('Мест должно быть больше нуля').max(500).optional(),
  locationName: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
}).refine((d) => d.endTime > d.startTime, {
  message: 'Время окончания должно быть позже времени начала',
});

async function guideFrom(request: NextRequest): Promise<string | NextResponse> {
  const auth = await requireRole(request, ['guide', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const guideId = await getGuidePartnerId(auth.userId);
  if (!guideId) {
    return NextResponse.json(
      { success: false, error: 'Профиль гида не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }
  return guideId;
}

const unavailable = (what: string) => NextResponse.json(
  { success: false, error: `Не удалось проверить ${what}. Попробуйте ещё раз через минуту.` } as ApiResponse<null>,
  { status: 503 },
);

/** GET /api/guide/schedule?dateFrom=&dateTo=&status= — записи и назначения в диапазоне. */
export async function GET(request: NextRequest) {
  const guideId = await guideFrom(request);
  if (guideId instanceof NextResponse) return guideId;

  const sp = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    dateFrom: sp.get('dateFrom') ?? undefined,
    dateTo: sp.get('dateTo') ?? undefined,
    status: sp.get('status') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректный период' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const { dateFrom, dateTo, status } = parsed.data;

  try {
    const [entries, assignments] = await Promise.all([
      query<ScheduleRow>(SCHEDULE_SQL.list, [guideId, dateFrom, dateTo, status === 'all' ? null : status]),
      query<{ booking_id: string; booking_date: string; tour_title: string; participants: number; booking_status: string }>(
        TEAM_SQL.assignedInRange, [guideId, dateFrom, dateTo],
      ),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        schedule: entries.rows.map(mapScheduleRow),
        // Назначения оператора в тот же период — без ПД туриста: контакт
        // живёт в «Группах», здесь только что и когда.
        assignments: assignments.rows.map((r) => ({
          bookingId: r.booking_id,
          date: r.booking_date,
          tourTitle: r.tour_title,
          participants: Number(r.participants),
          status: r.booking_status,
        })),
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.schedule.list', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить расписание. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

/** POST /api/guide/schedule — новая запись календаря. */
export async function POST(request: NextRequest) {
  const guideId = await guideFrom(request);
  if (guideId instanceof NextResponse) return guideId;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const d = parsed.data;

  if (d.operatorBookingId) {
    const assigned = await bookingAssignedToGuide(d.operatorBookingId, guideId);
    if (assigned === 'unknown') return unavailable('назначение на бронь');
    if (assigned === 'denied') {
      return NextResponse.json(
        { success: false, error: 'Бронь не найдена среди назначенных вам' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    const dup = await checkBookingEntryConflict({ guideId, operatorBookingId: d.operatorBookingId });
    if (dup === 'unknown') return unavailable('расписание');
    if (dup === 'conflict') {
      return NextResponse.json(
        { success: false, error: 'Для этой брони запись в расписании уже есть' } as ApiResponse<null>,
        { status: 409 },
      );
    }
  }

  const overlap = await checkScheduleOverlap({ guideId, date: d.date, startTime: d.startTime, endTime: d.endTime });
  if (overlap === 'unknown') return unavailable('расписание');
  if (overlap === 'conflict') {
    return NextResponse.json(
      { success: false, error: 'В это время у вас уже есть запись. Выберите другое время.' } as ApiResponse<null>,
      { status: 409 },
    );
  }

  try {
    const result = await query<{ id: string }>(SCHEDULE_SQL.insert, [
      guideId, d.date, d.startTime, d.endTime, d.title, d.description ?? null,
      d.operatorBookingId ?? null, d.maxParticipants ?? null, d.locationName ?? null, d.notes ?? null,
    ]);
    return NextResponse.json({
      success: true,
      data: { id: result.rows[0]?.id },
      message: 'Запись добавлена в расписание',
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.schedule.insert', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить запись. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
