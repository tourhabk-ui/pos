import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { SCHEDULE_SQL } from '@/lib/guides/team-queries';
import { logGuideFailure, UUID_RE } from '@/lib/guides/team';
import { checkScheduleOverlap, scheduleOwnership } from '@/lib/guides/schedule';
import { mapScheduleRow, DATE_RE, TIME_RE, SCHEDULE_STATUSES, type ScheduleRow } from '@/lib/guides/schedule-shape';

export const dynamic = 'force-dynamic';

/**
 * GET/PUT/DELETE /api/guide/schedule/[id] — одна запись личного календаря
 * гида. Владение — `guide_id` записи = профиль гида из JWT; три исхода
 * (ok / не ваша / не смогли проверить → 503), а не «не найдена» на отказ базы.
 */

const UpdateSchema = z.object({
  date: z.string().regex(DATE_RE, 'Дата — в формате ГГГГ-ММ-ДД').optional(),
  startTime: z.string().regex(TIME_RE, 'Время начала — ЧЧ:ММ').optional(),
  endTime: z.string().regex(TIME_RE, 'Время окончания — ЧЧ:ММ').optional(),
  title: z.string().trim().min(1, 'Название не может быть пустым').max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(SCHEDULE_STATUSES).optional(),
  maxParticipants: z.number().int().positive('Мест должно быть больше нуля').max(500).optional(),
  participantsCount: z.number().int().min(0, 'Число участников не может быть отрицательным').max(500).optional(),
  locationName: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
}).refine((d) => Object.values(d).some((v) => v !== undefined), {
  message: 'Укажите хотя бы одно поле для обновления',
});

/** Поле API → колонка. Имена колонок только отсюда: в SQL не попадает ничего чужого. */
const COLUMN: Record<string, string> = {
  date: 'tour_date',
  startTime: 'start_time',
  endTime: 'end_time',
  title: 'title',
  description: 'description',
  status: 'status',
  maxParticipants: 'max_participants',
  participantsCount: 'participants_count',
  locationName: 'location_name',
  notes: 'notes',
};

const notFound = () => NextResponse.json(
  { success: false, error: 'Запись расписания не найдена' } as ApiResponse<null>,
  { status: 404 },
);
const unavailable = () => NextResponse.json(
  { success: false, error: 'Не удалось проверить расписание. Попробуйте ещё раз через минуту.' } as ApiResponse<null>,
  { status: 503 },
);

async function resolve(request: NextRequest, params: Promise<{ id: string }>) {
  const auth = await requireRole(request, ['guide', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const guideId = await getGuidePartnerId(auth.userId);
  if (!guideId) {
    return NextResponse.json(
      { success: false, error: 'Профиль гида не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const own = await scheduleOwnership(id, guideId);
  if (own.state === 'unknown') return unavailable();
  if (own.state === 'denied') return notFound();
  return { guideId, id, operatorBookingId: own.operatorBookingId };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolve(request, params);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { rows } = await query<ScheduleRow>(SCHEDULE_SQL.one, [ctx.id, ctx.guideId]);
    if (rows.length === 0) return notFound();
    return NextResponse.json({ success: true, data: mapScheduleRow(rows[0]) } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.schedule.one', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить запись расписания' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolve(request, params);
  if (ctx instanceof NextResponse) return ctx;

  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const patch = parsed.data;

  let current: ScheduleRow;
  try {
    const { rows } = await query<ScheduleRow>(SCHEDULE_SQL.one, [ctx.id, ctx.guideId]);
    if (rows.length === 0) return notFound();
    current = rows[0];
  } catch (error) {
    logGuideFailure('guide.schedule.current', error);
    return unavailable();
  }

  const date = patch.date ?? current.tour_date;
  const start = patch.startTime ?? current.start_time;
  const end = patch.endTime ?? current.end_time;
  if (end !== null && end <= start) {
    return NextResponse.json(
      { success: false, error: 'Время окончания должно быть позже времени начала' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  const nextStatus = patch.status ?? current.status;
  const touchesTime = patch.date !== undefined || patch.startTime !== undefined || patch.endTime !== undefined
    || (patch.status !== undefined && patch.status !== 'cancelled' && current.status === 'cancelled');
  if (touchesTime && nextStatus !== 'cancelled') {
    const overlap = await checkScheduleOverlap({
      guideId: ctx.guideId, date, startTime: start, endTime: end ?? '23:59', excludeId: ctx.id,
    });
    if (overlap === 'unknown') return unavailable();
    if (overlap === 'conflict') {
      return NextResponse.json(
        { success: false, error: 'Новое время пересекается с другой вашей записью' } as ApiResponse<null>,
        { status: 409 },
      );
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const col = COLUMN[key];
    if (!col) continue;
    values.push(value);
    const cast = col === 'tour_date' ? '::date' : col === 'start_time' || col === 'end_time' ? '::time' : '';
    sets.push(`${col} = $${values.length}${cast}`);
  }
  values.push(ctx.id, ctx.guideId);

  try {
    const { rows } = await query<{ id: string }>(
      `UPDATE guide_schedule SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length - 1}::uuid AND guide_id = $${values.length}
        RETURNING id`,
      values,
    );
    if (rows.length === 0) return notFound();
    return NextResponse.json({ success: true, data: { id: rows[0].id }, message: 'Расписание обновлено' } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.schedule.update', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось обновить запись. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolve(request, params);
  if (ctx instanceof NextResponse) return ctx;

  try {
    // Запись по назначенной брони не стирается, а отменяется: след того, что
    // гид её планировал, нужен при разборе. Личная запись удаляется.
    if (ctx.operatorBookingId) {
      await query(
        `UPDATE guide_schedule SET status = 'cancelled', updated_at = NOW() WHERE id = $1::uuid AND guide_id = $2`,
        [ctx.id, ctx.guideId],
      );
      return NextResponse.json({ success: true, message: 'Запись отменена (бронь сохранена)' } as ApiResponse<null>);
    }
    await query('DELETE FROM guide_schedule WHERE id = $1::uuid AND guide_id = $2', [ctx.id, ctx.guideId]);
    return NextResponse.json({ success: true, message: 'Запись удалена' } as ApiResponse<null>);
  } catch (error) {
    logGuideFailure('guide.schedule.delete', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось удалить запись. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
