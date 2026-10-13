import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperatorTeam } from '@/lib/operators/team-access';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const BlockDatesSchema = z.object({
  tourId:    z.coerce.number().int().positive('tourId обязателен'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate: формат YYYY-MM-DD'),
  endDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate: формат YYYY-MM-DD'),
  reason:    z.string().max(255).optional(),
});

const UnblockDatesSchema = z.object({
  tourId:    z.coerce.number().int().positive('tourId обязателен'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Кабинет — свой у владельца или командный у менеджера (CRM 2г). Закрыть
// дату для продажи — работа команды: брони на эту дату это не отменяет.

function datesInRange(start: string, end: string): string[] {
  const result: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const fin = new Date(end   + 'T00:00:00Z');
  if (fin < cur) return result;
  while (cur <= fin) {
    result.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

// ─── POST /api/operator/calendar/block ────────────────────────────────────────
// Блокирует диапазон дат для тура.

export async function POST(request: NextRequest) {
  const ctx = await requireOperatorTeam(request, { noProfileStatus: 404 });
  if (ctx instanceof NextResponse) return ctx;
  const operatorId = ctx.partnerId;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BlockDatesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { tourId, startDate, endDate, reason } = parsed.data;

  // Проверяем владение туром
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM operator_tours WHERE id = $1 AND operator_id = $2 LIMIT 1`,
    [tourId, operatorId]
  );
  if (ownerRows.length === 0) {
    return NextResponse.json({ success: false, error: 'Тур не найден или нет прав' }, { status: 404 });
  }

  const dates = datesInRange(startDate, endDate);
  if (dates.length === 0) {
    return NextResponse.json({ success: false, error: 'Некорректный диапазон дат' }, { status: 400 });
  }
  if (dates.length > 366) {
    return NextResponse.json({ success: false, error: 'Диапазон не может превышать 366 дней' }, { status: 400 });
  }

  try {
    await Promise.all(
      dates.map(date =>
        pool.query(
          `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
           VALUES ($1, $2, 0, true, $3)
           ON CONFLICT (operator_tour_id, date) DO UPDATE SET
             is_cancelled        = true,
             cancellation_reason = EXCLUDED.cancellation_reason,
             updated_at          = NOW()`,
          [tourId, date, reason ?? 'Заблокировано оператором']
        )
      )
    );

    return NextResponse.json({
      success: true,
      data:    { blockedDates: dates.length, dates },
      message: `Заблокировано ${dates.length} дат`,
    });
  } catch (err) {
    console.error('[operator/calendar/block] POST не выполнен, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет SQLSTATE');
    return NextResponse.json({ success: false, error: 'Ошибка при блокировке дат' }, { status: 500 });
  }
}

// ─── DELETE /api/operator/calendar/block ──────────────────────────────────────
// Снимает блокировку с диапазона дат.

export async function DELETE(request: NextRequest) {
  const ctx = await requireOperatorTeam(request, { noProfileStatus: 404 });
  if (ctx instanceof NextResponse) return ctx;
  const operatorId = ctx.partnerId;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = UnblockDatesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { tourId, startDate, endDate } = parsed.data;

  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM operator_tours WHERE id = $1 AND operator_id = $2 LIMIT 1`,
    [tourId, operatorId]
  );
  if (ownerRows.length === 0) {
    return NextResponse.json({ success: false, error: 'Тур не найден или нет прав' }, { status: 404 });
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE tour_availability
       SET is_cancelled = false, cancellation_reason = NULL, updated_at = NOW()
       WHERE operator_tour_id = $1
         AND date >= $2
         AND date <= $3`,
      [tourId, startDate, endDate]
    );

    return NextResponse.json({
      success: true,
      data:    { unblocked: rowCount ?? 0 },
      message: `Разблокировано ${rowCount ?? 0} дат`,
    });
  } catch (err) {
    console.error('[operator/calendar/block] DELETE не выполнен, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет SQLSTATE');
    return NextResponse.json({ success: false, error: 'Ошибка при разблокировке дат' }, { status: 500 });
  }
}
