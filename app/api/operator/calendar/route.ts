import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SetAvailabilitySchema = z.object({
  tourId:          z.coerce.number().int().positive('tourId обязателен'),
  date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date: формат YYYY-MM-DD'),
  availableSlots:  z.number().int().min(0).optional(),
  isBlocked:       z.boolean().optional(),
  blockReason:     z.string().max(255).optional(),
  priceOverride:   z.number().min(0).optional(),
  weatherStatus:   z.enum(['unknown', 'ok', 'alert', 'cancelled']).optional(),
  notes:           z.string().optional(),
});

// Кабинет — свой у владельца или командный у менеджера (CRM 2г). Прежний
// поиск «первый профиль человека» не знал ни категории, ни команды: менеджер
// получал «профиль не найден». Перевод — после переписи 13.10
// (/api/cron/operator-cabinet-census, prod-check run 120): у 7 людей с ролью
// оператора туров и дат на профилях не оператора нет, calendar_switch_safe.
// У одного из них, кроме профиля оператора, есть ещё агент, перевозчик и гид:
// старый запрос без категории и порядка мог взять любой из четырёх.

// ─── GET /api/operator/calendar ───────────────────────────────────────────────
// Возвращает доступность слотов по турам оператора за диапазон дат.

export async function GET(request: NextRequest) {
  const ctx = await requireOperatorTeam(request, { noProfileStatus: 404 });
  if (ctx instanceof NextResponse) return ctx;
  const operatorId = ctx.partnerId;

  const { searchParams } = new URL(request.url);
  const tourId    = searchParams.get('tourId');
  const startDate = searchParams.get('startDate') ?? new Date().toISOString().slice(0, 10);
  const endDate   = searchParams.get('endDate')   ??
    new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  const params: unknown[] = [operatorId, startDate, endDate];
  let sql = `
    SELECT
      ta.id::text,
      ta.operator_tour_id::text                AS tour_id,
      t.title                                  AS tour_name,
      t.max_participants,
      ta.date::text,
      ta.available_slots,
      ta.booked_slots,
      ta.base_price_override,
      ta.weather_status,
      ta.is_cancelled,
      ta.cancellation_reason                   AS block_reason,
      -- Реальные брони за эту дату: SUM(participants) — люди, не COUNT(*)
      -- броней (групповая бронь на 5 человек занимает 5 мест, не 1)
      (${occupiedOnDaySql({ booking: 'b', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
      )                                        AS booked_spots,
      -- Колонки notes в tour_availability нет (migrations 040/041) — раньше
      -- SELECT падал и весь календарь отвечал 500. Контракт поля сохраняем.
      NULL::text                               AS notes
    FROM tour_availability ta
    JOIN operator_tours t ON ta.operator_tour_id = t.id
    WHERE t.operator_id = $1
      AND ta.date >= $2
      AND ta.date <= $3
  `;

  if (tourId) {
    params.push(tourId);
    sql += ` AND ta.operator_tour_id = $${params.length}`;
  }

  sql += ` ORDER BY ta.date ASC, t.title ASC`;

  try {
    const { rows } = await pool.query(sql, params);

    const availability = rows.map(r => ({
      id:              r.id,
      tourId:          r.tour_id,
      tourName:        r.tour_name,
      maxGroupSize:    r.max_participants,
      date:            r.date,
      availableSlots:  r.available_slots,
      bookedSlots:     r.booked_slots,
      bookedSpots:     r.booked_spots,
      remainingSlots:  Math.max(0, r.available_slots - r.booked_spots),
      priceOverride:   r.base_price_override ? Number(r.base_price_override) : null,
      weatherStatus:   r.weather_status,
      isCancelled:     r.is_cancelled,
      blockReason:     r.block_reason,
      notes:           r.notes,
    }));

    return NextResponse.json({ success: true, data: { availability } });
  } catch (err) {
    console.error('[operator/calendar] GET не выполнен, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет SQLSTATE');
    return NextResponse.json({ success: false, error: 'Ошибка при получении календаря' }, { status: 500 });
  }
}

// ─── POST /api/operator/calendar ──────────────────────────────────────────────
// Устанавливает / обновляет доступность для конкретной даты тура.

export async function POST(request: NextRequest) {
  const ctx = await requireOperatorTeam(request, { noProfileStatus: 404 });
  if (ctx instanceof NextResponse) return ctx;
  const operatorId = ctx.partnerId;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = SetAvailabilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { tourId, date, availableSlots, isBlocked, blockReason, priceOverride, weatherStatus } = parsed.data;

  // Цена на дату — это цена: менеджеру только с правом владельца (CRM 2г).
  const mayPrice = managerMay(ctx.access, 'can_edit_prices');
  if (priceOverride !== undefined && !mayPrice) return permissionDenied('can_edit_prices');

  // Проверяем владение туром
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM operator_tours WHERE id = $1 AND operator_id = $2 LIMIT 1`,
    [tourId, operatorId]
  );
  if (ownerRows.length === 0) {
    return NextResponse.json({ success: false, error: 'Тур не найден или нет прав' }, { status: 404 });
  }

  try {
    // Без права цен сохранение даты цену не трогает ($8 = false): иначе
    // «сохранить места» молча сбрасывало бы цену, которую поставил владелец.
    const { rows } = await pool.query(
      `INSERT INTO tour_availability (
         operator_tour_id, date, available_slots,
         is_cancelled, cancellation_reason, base_price_override, weather_status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (operator_tour_id, date) DO UPDATE SET
         available_slots     = EXCLUDED.available_slots,
         is_cancelled        = EXCLUDED.is_cancelled,
         cancellation_reason = EXCLUDED.cancellation_reason,
         base_price_override = CASE WHEN $8::boolean THEN EXCLUDED.base_price_override
                                    ELSE tour_availability.base_price_override END,
         weather_status      = EXCLUDED.weather_status,
         updated_at          = NOW()
       RETURNING id::text, operator_tour_id::text AS tour_id, date::text, available_slots, is_cancelled`,
      [
        tourId,
        date,
        availableSlots ?? 0,
        isBlocked ?? false,
        blockReason ?? null,
        priceOverride ?? null,
        weatherStatus ?? 'unknown',
        mayPrice,
      ]
    );

    return NextResponse.json({ success: true, data: rows[0], message: 'Доступность обновлена' });
  } catch (err) {
    console.error('[operator/calendar] POST не выполнен, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет SQLSTATE');
    return NextResponse.json({ success: false, error: 'Ошибка при установке доступности' }, { status: 500 });
  }
}
