/**
 * API endpoint для бронирования тура
 * POST /api/tours/[id]/book
 *
 * Body:
 * - date: дата тура (YYYY-MM-DD)
 * - adults: количество взрослых
 * - children: количество детей
 * - specialRequirements: специальные пожелания (optional)
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { z } from 'zod';
import { emailService } from '@/lib/notifications/email-service';
import { requireAuth } from '@/lib/auth/middleware';
import { getTokenFromRequest } from '@/lib/auth';
import { TourBookCheckRow } from '@/lib/types/db-rows';

// Валидация входных данных
const bookingSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверный формат даты'),
  adults: z.number().min(1, 'Минимум 1 взрослый').max(50, 'Максимум 50 взрослых'),
  children: z.number().min(0).max(20).optional().default(0),
  specialRequirements: z.string().optional(),
});

export const dynamic = 'force-dynamic';

// POST /api/tours/[id]/book - protected: requires auth
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) {
    return authResult;
  }
  const userId = authResult.userId;

  try {
    const { id: tourId } = await params;
    const body = await request.json();

    // Валидация
    const validationResult = bookingSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Ошибка валидации',
          details: validationResult.error.issues,
        },
        { status: 400 }
      );
    }

    const {
      date,
      adults,
      children,
      specialRequirements,
    } = validationResult.data;

    const totalParticipants = adults + children;

    // Проверяем существование тура
    const tourCheckResult = await query<TourBookCheckRow>(
      `SELECT
        t.id,
        t.title AS name,
        t.base_price AS price,
        t.max_participants AS max_group_size,
        t.min_group_size,
        t.is_active,
        p.name as operator_name,
        p.email as operator_email
      FROM operator_tours t
      JOIN partners p ON t.operator_id = p.id
      WHERE t.id = $1 AND t.is_active = true AND t.deleted_at IS NULL`,
      [tourId]
    );

    if (tourCheckResult.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Тур не найден или недоступен' },
        { status: 404 }
      );
    }

    const tour = tourCheckResult.rows[0];

    // Проверяем минимальное и максимальное количество участников
    if (totalParticipants < tour.min_group_size) {
      return NextResponse.json(
        {
          success: false,
          error: `Минимум участников: ${tour.min_group_size}`,
        },
        { status: 400 }
      );
    }

    if (totalParticipants > tour.max_group_size) {
      return NextResponse.json(
        {
          success: false,
          error: `Максимум участников: ${tour.max_group_size}`,
        },
        { status: 400 }
      );
    }

    // Занятость считаем по УЧАСТНИКАМ, а не по числу броней: COUNT(*) считал
    // заявки, из-за чего одна бронь на десятерых занимала одно место из
    // max_group_size, а десять броней по одному — десять. На туре с выходом в
    // поле перебор группы — это не бухгалтерия, а гид на четверых с толпой.
    const availabilityCheck = await query<{ taken: string | null }>(
      `SELECT COALESCE(SUM(participants), 0) AS taken
       FROM operator_bookings
       WHERE operator_tour_id = $1
         AND DATE(booking_date) = $2
         AND booking_status NOT IN ('cancelled')
         AND deleted_at IS NULL`,
      [tourId, date]
    );

    const existingBookings = parseInt(availabilityCheck.rows[0]?.taken ?? '0');
    const availableSpots = tour.max_group_size - existingBookings;

    if (totalParticipants > availableSpots) {
      return NextResponse.json(
        {
          success: false,
          error: `Недостаточно мест. Доступно: ${availableSpots}`,
        },
        { status: 409 }
      );
    }

    // Рассчитываем стоимость
    const adultPrice = parseFloat(tour.price);
    const childPrice = adultPrice * 0.5; // Дети со скидкой 50%
    const totalPrice = (adults * adultPrice) + (children * childPrice);

    // Данные туриста нужны до вставки: оператор видит в брони имя и почту, а не
    // один user_id.
    const userResult = await query<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = $1', [userId]);
    const userEmail = userResult.rows[0]?.email ?? null;
    const userName = userResult.rows[0]?.name || 'Гость';

    // Пишем в мастер-таблицу operator_bookings.
    //
    // Раньше здесь был INSERT в `bookings` — а это не таблица, а совместимая
    // VIEW над operator_bookings (миграция 132). Представление новых колонок
    // базы не подхватывает: `end_date` появился в миграции 140 уже после него,
    // `currency` во view не выведен вовсе, а `total_price` там — выражение
    // COALESCE, в которое PostgreSQL писать не даёт. То есть запрос падал на
    // разборе при каждом вызове, и «бронирование тура» существовало только в
    // виде маршрута. Фронт его не звал, поэтому поломка никого не разбудила —
    // но эндпоинт открыт, и первый же клиент, который на него сядет, получил
    // бы 500 на оплаченном намерении.
    const bookingResult = await query<{ id: string }>(
      `INSERT INTO operator_bookings (
        operator_tour_id,
        user_id,
        tourist_name,
        tourist_email,
        booking_date,
        end_date,
        duration_days,
        participants,
        base_total_price,
        final_price,
        currency,
        booking_status,
        payment_status,
        created_via,
        special_requests
      )
      VALUES ($1, $2, $3, $4, $5, $5, 1, $6, $7, $7, 'RUB', 'new', 'pending', 'website', $8)
      RETURNING id`,
      [
        tourId,
        userId,
        userName,
        userEmail,
        date, // однодневный тур: end_date совпадает с датой выхода
        totalParticipants,
        totalPrice,
        specialRequirements || null,
      ]
    );

    const bookingId = bookingResult.rows[0].id;

    // Создаем платеж через CloudPayments (передаём токен из входящего запроса)
    let paymentData = null;
    try {
      const authToken = getTokenFromRequest(request);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      };
      // URL платёжного роута — от текущего запроса (тот же фикс, что в
      // бронировании жилья): localhost-фолбэк бил мимо прод-порта.
      const paymentResponse = await fetch(new URL('/api/payments/create', request.url), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bookingId,
          bookingType: 'tour',
          amount: totalPrice,
          currency: 'RUB',
          userEmail,
          description: `Оплата тура: ${tour.name}`,
        }),
      });

      if (paymentResponse.ok) {
        const paymentResult = await paymentResponse.json();
        if (paymentResult.success) {
          paymentData = paymentResult.data;
        }
      }
    } catch (paymentError) {
      // Не прерываем выполнение при ошибке платежа
    }

    // Email гостю — честный: заявка создана и ждёт подтверждения оператора,
    // прежний текст объявлял бронь подтверждённой на первом же касании.
    if (userEmail) {
    try {
      await emailService.sendEmail({
        to: userEmail,
        subject: `Заявка на бронирование принята: ${tour.name}`,
        html: `
          <h2>Заявка на бронирование принята</h2>
          <p>Оператор подтвердит её в ближайшее время — мы сообщим.</p>
          <p><strong>Тур:</strong> ${tour.name}</p>
          <p><strong>Оператор:</strong> ${tour.operator_name}</p>
          <p><strong>Дата:</strong> ${date}</p>
          <p><strong>Участники:</strong> ${adults} взрослых, ${children} детей</p>
          <p><strong>Итого:</strong> ${totalPrice.toLocaleString('ru-RU')} ₽</p>
          <p><strong>ID заявки:</strong> ${bookingId}</p>
        `
      });
    } catch (_emailError) {
      // Не прерываем выполнение при ошибке email
    }
    }

    return NextResponse.json({
      success: true,
      message: 'Бронирование создано успешно!',
      data: {
        bookingId,
        tourName: tour.name,
        operatorName: tour.operator_name,
        date,
        adults,
        children,
        totalParticipants,
        priceBreakdown: {
          adultPrice,
          childPrice,
          totalPrice,
          currency: 'RUB',
        },
        // Статус отдаём тот, что реально записан (booking_status = 'new'), а не
        // придуманный для ответа: расхождение витрины с базой — то же враньё,
        // только вежливое.
        status: 'new',
        paymentStatus: 'pending',
        paymentUrl: `/hub/tours/bookings/${bookingId}/payment`,
        payment: paymentData ? {
          paymentId: paymentData.paymentId,
          amount: paymentData.amount,
          currency: paymentData.currency,
          description: paymentData.description,
          invoiceId: paymentData.invoiceId,
        } : null,
      },
    });

  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: 'Ошибка при создании бронирования',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
