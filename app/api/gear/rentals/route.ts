import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getGearPartnerId } from '@/lib/auth/gear-helpers';
import { calcRentalDays, calcGearPrice } from '@/lib/gear/pricing';
import { notifyNewGearRental } from '@/lib/notifications/gear-rental';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CreateGearRentalSchema = z.object({
  gearId: z.string().uuid('Некорректный ID снаряжения'),
  customer: z.object({
    name: z.string().min(1, 'Имя обязательно').max(255),
    email: z.string().email('Некорректный email'),
    phone: z.string().min(5, 'Номер телефона обязателен').max(50),
  }),
  rental: z.object({
    startDate: z.string().regex(ISO_DATE, 'Дата начала — в формате ГГГГ-ММ-ДД'),
    endDate: z.string().regex(ISO_DATE, 'Дата окончания — в формате ГГГГ-ММ-ДД'),
    quantity: z.number().int().positive('Количество должно быть целым числом больше 0').max(50),
    insurance: z.boolean().optional(),
  }),
  comments: z.string().max(2000).optional(),
});

/**
 * POST /api/gear/rentals - Создание заявки на аренду снаряжения.
 *
 * ПУБЛИЧНЫЙ вход (как лиды): витрина /gear открыта всем, форма собирает
 * контакты — требовать логин на последнем шаге значило молча рвать воронку
 * 401-м (что и происходило). Спам сдерживают Edge rate-limit + Zod.
 *
 * Цена — ТОЛЬКО сервером, единым модулем lib/gear/pricing (им же считает
 * форма, поэтому показанное и записанное совпадают). Страховка — из
 * insurance_cost_per_day позиции; нет тарифа — заявка со страховкой
 * отклоняется честной ошибкой, а не молчаливым нулём.
 *
 * Доступность — по ДАТАМ: пик пересекающихся невозвращённых аренд
 * (pending/confirmed/active/overdue) в запрошенном окне не должен
 * превышать общее количество единиц. Раньше проверялся только мгновенный
 * сток — две брони на одни даты проходили обе.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateGearRentalSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const { gearId, customer, rental, comments } = parsed.data;

    const rentalDays = calcRentalDays(rental.startDate, rental.endDate);
    if (rentalDays === null) {
      return NextResponse.json(
        { success: false, error: 'Дата окончания должна быть позже даты начала' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    if (rentalDays > 365) {
      return NextResponse.json(
        { success: false, error: 'Максимальный срок аренды — год. Свяжитесь с прокатом напрямую.' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const gearResult = await query<{
      name: string;
      quantity: number;
      price_per_day: string;
      price_per_week: string | null;
      price_per_month: string | null;
      insurance_cost_per_day: string | null;
      partner_id: string | null;
    }>(`
      SELECT name, quantity, price_per_day, price_per_week, price_per_month,
             insurance_cost_per_day, partner_id
      FROM gear_items
      WHERE id = $1 AND is_active = TRUE
    `, [gearId]);

    if (gearResult.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Снаряжение не найдено' } as ApiResponse<null>,
        { status: 404 }
      );
    }
    const gear = gearResult.rows[0];

    const pricePerDay = Number(gear.price_per_day);
    if (!Number.isFinite(pricePerDay) || pricePerDay < 0) {
      return NextResponse.json(
        { success: false, error: 'Ошибка конфигурации цен снаряжения' } as ApiResponse<null>,
        { status: 500 }
      );
    }

    // Честная занятость: пик одновременно занятых единиц по дням окна.
    const overlapResult = await query<{ peak_rented: string }>(`
      SELECT COALESCE(MAX(day_rented), 0)::text AS peak_rented
      FROM (
        SELECT SUM(gr.quantity) AS day_rented
        FROM generate_series($2::date, $3::date - 1, '1 day') AS d(day)
        LEFT JOIN gear_rentals gr
          ON gr.gear_id = $1
         AND gr.status IN ('pending', 'confirmed', 'active', 'overdue')
         AND gr.start_date <= d.day
         AND gr.end_date > d.day
        GROUP BY d.day
      ) t
    `, [gearId, rental.startDate, rental.endDate]);

    const peakRented = parseInt(overlapResult.rows[0]?.peak_rented ?? '0', 10);
    if (peakRented + rental.quantity > gear.quantity) {
      const free = Math.max(0, gear.quantity - peakRented);
      return NextResponse.json(
        {
          success: false,
          error: free > 0
            ? `На выбранные даты свободно только ${free} шт.`
            : 'На выбранные даты снаряжение уже занято',
        } as ApiResponse<null>,
        { status: 409 }
      );
    }

    const price = calcGearPrice({
      days: rentalDays,
      quantity: rental.quantity,
      pricePerDay,
      pricePerWeek: gear.price_per_week != null ? Number(gear.price_per_week) : null,
      pricePerMonth: gear.price_per_month != null ? Number(gear.price_per_month) : null,
      insurancePerDay: gear.insurance_cost_per_day != null ? Number(gear.insurance_cost_per_day) : null,
      insurance: rental.insurance,
    });

    if (price.insuranceUnavailable) {
      return NextResponse.json(
        { success: false, error: 'Для этой позиции страховка недоступна — уберите галку страховки' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const result = await query<{ id: string }>(`
      INSERT INTO gear_rentals (
        id, gear_id, customer_name, customer_email, customer_phone,
        start_date, end_date, quantity, days_count, insurance,
        base_price, insurance_cost, total_price, comments, status, created_at
      ) VALUES (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', NOW()
      ) RETURNING id
    `, [
      gearId,
      customer.name,
      customer.email,
      customer.phone,
      rental.startDate,
      rental.endDate,
      rental.quantity,
      rentalDays,
      Boolean(rental.insurance) && price.insuranceCost > 0,
      price.basePrice,
      price.insuranceCost,
      price.totalPrice,
      comments || null,
    ]);

    const rentalId = result.rows[0].id;

    // Партнёр и админ узнают о заявке сразу, а не когда сами зайдут в кабинет.
    if (gear.partner_id) {
      const chat = await query<{ telegram_chat_id: string | null }>(
        `SELECT telegram_chat_id FROM partners WHERE id = $1`,
        [gear.partner_id]
      ).catch(() => null);
      notifyNewGearRental({
        rentalId,
        gearName: gear.name,
        quantity: rental.quantity,
        startDate: rental.startDate,
        endDate: rental.endDate,
        totalPrice: price.totalPrice,
        customerName: customer.name,
        customerPhone: customer.phone,
        partnerChatId: chat?.rows[0]?.telegram_chat_id ?? null,
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      data: {
        rentalId,
        totalPrice: price.totalPrice,
        message: 'Заявка на аренду создана успешно',
      }
    } as ApiResponse<{ rentalId: string; totalPrice: number; message: string }>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка создания заявки на аренду' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

/**
 * GET /api/gear/rentals - Получение списка заявок на аренду (для администратора)
 */
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireAuth(request);
    if (userOrResponse instanceof NextResponse) {
      return userOrResponse;
    }

    const userId = userOrResponse.userId;
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const isAdmin = userOrResponse.role === 'admin';
    const partnerId = isAdmin ? null : await getGearPartnerId(userId);
    if (!isAdmin && !partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль партнёра не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const parsedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
    const allowedStatuses = new Set(['pending', 'confirmed', 'active', 'completed', 'cancelled', 'overdue']);

    if (status && !allowedStatuses.has(status)) {
      return NextResponse.json(
        { success: false, error: 'Некорректный статус' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    let queryText = `
      SELECT
        gr.id,
        gr.gear_id,
        gr.customer_name,
        gr.customer_email,
        gr.customer_phone,
        gr.start_date,
        gr.end_date,
        gr.quantity,
        gr.days_count,
        gr.insurance,
        gr.base_price,
        gr.insurance_cost,
        gr.total_price,
        gr.comments,
        gr.status,
        gr.created_at,
        g.name as gear_name,
        g.category as gear_category
      FROM gear_rentals gr
      JOIN gear_items g ON gr.gear_id = g.id
    `;

    const params: (string | number)[] = [];
    const whereConditions: string[] = [];

    // Бизнес-правило: партнёр видит только свои заявки, admin — все.
    if (!isAdmin && partnerId) {
      whereConditions.push(`g.partner_id = $${params.length + 1}`);
      params.push(partnerId);
    }

    // Фильтр по статусу
    if (status) {
      whereConditions.push(`gr.status = $${params.length + 1}`);
      params.push(status);
    }

    if (whereConditions.length > 0) {
      queryText += ` WHERE ${whereConditions.join(' AND ')}`;
    }

    queryText += ` ORDER BY gr.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query(queryText, params);

    return NextResponse.json({
      success: true,
      data: {
        rentals: result.rows,
        count: result.rows.length
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка получения заявок на аренду' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
