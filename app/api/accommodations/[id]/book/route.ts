/**
 * API endpoint для бронирования номера
 * POST /api/accommodations/[id]/book
 * 
 * Body:
 * - roomId: ID номера
 * - checkInDate: дата заезда (YYYY-MM-DD)
 * - checkOutDate: дата выезда (YYYY-MM-DD)
 * - adults: количество взрослых
 * - children: количество детей
 * - specialRequests: специальные пожелания (optional)
 * - guestNotes: заметки гостя (optional)
 *
 * Оплата жилья — НА МЕСТЕ (решение владельца 26.09): гость бронирует,
 * владелец подтверждает, гость платит владельцу при заселении. Платформа
 * платёж по брони жилья не создаёт; онлайн-оплата — отдельный будущий шаг.
 */

import { NextRequest, NextResponse } from 'next/server';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { query, transaction } from '@/lib/database';
import { z } from 'zod';
import { emailService } from '@/lib/notifications/email-service';
import { requireAuth } from '@/lib/auth/middleware';
import { notifyNewStayBooking, logStayFailure, STAY_PAY_ON_SITE } from '@/lib/notifications/stay-booking';
import { escapeHtml, safeSubject } from '@/lib/text/escape-html';
import {
  roomNightsSql, firstUnsellableNight, type RoomNightRow,
  PENDING_HOLD_INTERVAL_SQL, MAX_HOLDING_PENDING_PER_PROPERTY,
} from '@/lib/stay/availability';

// Валидация входных данных
const bookingSchema = z.object({
  roomId: z.string().uuid('Неверный ID номера'),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверный формат даты'),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверный формат даты'),
  adults: z.number().min(1, 'Минимум 1 взрослый').max(20, 'Максимум 20 взрослых'),
  children: z.number().min(0).max(10).optional().default(0),
  specialRequests: z.string().max(2000, 'Пожелания — не длиннее 2000 символов').optional(),
  guestNotes: z.string().max(2000, 'Заметки — не длиннее 2000 символов').optional(),
});

export const dynamic = 'force-dynamic';

// POST /api/accommodations/[id]/book - protected: requires auth
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
    const { id: rawAccommodationId } = await params;
    const idCheck = z.string().uuid().safeParse(rawAccommodationId);
    if (!idCheck.success) {
      return NextResponse.json({ success: false, error: 'Некорректный ID объекта' }, { status: 400 });
    }
    const accommodationId = idCheck.data;
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
      roomId,
      checkInDate,
      checkOutDate,
      adults,
      children,
      specialRequests,
      guestNotes,
    } = validationResult.data;
    
    // Проверяем даты
    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (checkIn < today) {
      return NextResponse.json(
        { success: false, error: 'Дата заезда не может быть в прошлом' },
        { status: 400 }
      );
    }
    
    if (checkOut <= checkIn) {
      return NextResponse.json(
        { success: false, error: 'Дата выезда должна быть после даты заезда' },
        { status: 400 }
      );
    }
    
    // Вычисляем количество ночей
    const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
    
    if (nights > 365) {
      return NextResponse.json(
        { success: false, error: 'Максимальная длительность бронирования - 365 ночей' },
        { status: 400 }
      );
    }
    
    // Проверяем существование объекта и номера
    const roomCheckResult = await query<{
      id: string; accommodation_id: string; name: string; max_guests: number;
      available_rooms: number; price_per_night: string; accommodation_name: string; is_active: boolean;
    }>(
      `SELECT 
        r.id,
        r.accommodation_id,
        r.name,
        r.max_guests,
        r.available_rooms,
        r.price_per_night,
        a.name as accommodation_name,
        a.is_active
      FROM accommodation_rooms r
      JOIN accommodations a ON r.accommodation_id = a.id
      WHERE r.id = $1 AND a.id = $2 AND r.is_active = true AND ${publicAccommodationSql('a')}`,
      [roomId, accommodationId]
    );
    
    if (roomCheckResult.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Номер не найден или недоступен' },
        { status: 404 }
      );
    }
    
    const room = roomCheckResult.rows[0];
    
    // Проверяем максимальное количество гостей
    const totalGuests = adults + children;
    if (totalGuests > room.max_guests) {
      return NextResponse.json(
        {
          success: false,
          error: `Превышено максимальное количество гостей (макс: ${room.max_guests})`,
        },
        { status: 400 }
      );
    }
    
    // Тарифный календарь владельца (accommodation_availability):
    // блокировки закрывают продажу, price_override меняет цену ночи.
    // Строка уровня объекта (room_id IS NULL) действует на все номера,
    // строка уровня номера — точнее и приоритетнее.
    const ratesResult = await query<{
      date: string; room_id: string | null; price_override: string | null; is_blocked: boolean;
    }>(
      `SELECT date::text, room_id, price_override, is_blocked
       FROM accommodation_availability
       WHERE accommodation_id = $1
         AND date >= $2 AND date < $3
         AND (room_id IS NULL OR room_id = $4)`,
      [accommodationId, checkInDate, checkOutDate, roomId]
    );

    const blockedDate = ratesResult.rows.find(r => r.is_blocked);
    if (blockedDate) {
      return NextResponse.json(
        {
          success: false,
          error: `Владелец закрыл продажу на ${blockedDate.date.split('-').reverse().join('.')} — выберите другие даты`,
        },
        { status: 409 }
      );
    }

    // Рассчитываем стоимость по ночам: override номера > override объекта > базовая
    const basePricePerNight = parseFloat(room.price_per_night);
    const roomOverrides = new Map<string, number>();
    const objectOverrides = new Map<string, number>();
    for (const r of ratesResult.rows) {
      if (r.price_override == null) continue;
      (r.room_id ? roomOverrides : objectOverrides).set(r.date, parseFloat(r.price_override));
    }

    let totalPrice = 0;
    const nightMs = 24 * 60 * 60 * 1000;
    const checkInUtc = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
    for (let n = 0; n < nights; n++) {
      const night = new Date(checkInUtc + n * nightMs).toISOString().slice(0, 10);
      totalPrice += roomOverrides.get(night) ?? objectOverrides.get(night) ?? basePricePerNight;
    }
    // room_price_per_night в брони — средняя за ночь (тарифы по датам могут различаться)
    const pricePerNight = Math.round((totalPrice / nights) * 100) / 100;

    // Проверка занятости и INSERT — в одной транзакции под advisory-lock по
    // ОБЪЕКТУ: раньше COUNT и INSERT шли отдельными запросами, и две
    // одновременные брони последнего номера проходили обе (гонка овербукинга).
    // Ключ — объект, а не номер: число владельца на дату уровня объекта
    // ограничивает все номера сразу, и подтверждение заявки (PATCH) берёт тот
    // же ключ. Lock снимается автоматически на COMMIT/ROLLBACK.
    //
    // Занятость — по НОЧАМ единой формулой (lib/stay/availability.ts): фонд
    // номера, число владельца на дату, брони, которые держат номер. Прежний
    // счёт «броней, пересекающих окно» занимал номер на всё окно бронью на
    // одну его ночь.
    const bookingOutcome = await transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [accommodationId]);

      // Заявки не стоят денег (оплата на месте), поэтому число одновременно
      // висящих заявок одного гостя на объекте ограничено: иначе ими можно
      // закрыть весь фонд. Считаются только те, что ещё держат номер.
      const pendingResult = await client.query<{ holding: number }>(
        `SELECT COUNT(*)::int AS holding
           FROM accommodation_bookings b
          WHERE b.user_id = $1 AND b.accommodation_id = $2
            AND b.status = 'pending'
            AND b.created_at > NOW() - ${PENDING_HOLD_INTERVAL_SQL}`,
        [userId, accommodationId]
      );
      if (Number(pendingResult.rows[0]?.holding ?? 0) >= MAX_HOLDING_PENDING_PER_PROPERTY) {
        return { code: 'too_many_pending' as const };
      }

      const nightsResult = await client.query<RoomNightRow>(
        roomNightsSql({ accommodation: '$1::uuid', start: '$2::date', endExclusive: '$3::date', room: '$4' }),
        [accommodationId, checkInDate, checkOutDate, roomId]
      );
      const unsellable = firstUnsellableNight(nightsResult.rows);
      if (nightsResult.rows.length === 0 || unsellable) {
        return { code: 'conflict' as const, night: unsellable?.night ?? null, reason: unsellable?.reason ?? 'full' };
      }

      const bookingResult = await client.query(
        `INSERT INTO accommodation_bookings (
          user_id,
          accommodation_id,
          room_id,
          check_in_date,
          check_out_date,
          nights,
          adults,
          children,
          room_price_per_night,
          total_price,
          currency,
          status,
          payment_status,
          special_requests,
          guest_notes,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        RETURNING id`,
        [
          userId,
          accommodationId,
          roomId,
          checkInDate,
          checkOutDate,
          nights,
          adults,
          children,
          pricePerNight,
          totalPrice,
          'RUB',
          'pending', // статус
          'pending', // payment_status: оплата на месте, платформа её не принимает
          specialRequests || null,
          guestNotes || null,
        ]
      );
      return { code: 'created' as const, bookingId: bookingResult.rows[0].id as string };
    });

    if (bookingOutcome.code === 'too_many_pending') {
      return NextResponse.json(
        {
          success: false,
          error: `У вас уже ${MAX_HOLDING_PENDING_PER_PROPERTY} заявки на этот объект, ожидающие подтверждения владельца. Дождитесь ответа или отмените лишние в разделе «Мои проживания».`,
        },
        { status: 429 }
      );
    }

    if (bookingOutcome.code === 'conflict') {
      const when = bookingOutcome.night ? ` на ${bookingOutcome.night.split('-').reverse().join('.')}` : '';
      return NextResponse.json(
        {
          success: false,
          error: bookingOutcome.reason === 'blocked'
            ? `Владелец закрыл продажу${when} — выберите другие даты`
            : `К сожалению, свободных номеров этого типа${when} нет — выберите другие даты или номер`,
        },
        { status: 409 }
      );
    }

    const bookingId = bookingOutcome.bookingId;

    // Контакты гостя — для письма ему и уведомления владельцу. Сбой чтения
    // не отменяет уже созданную бронь, но оставляет след (§4.0).
    let userEmail: string | null = null;
    let userName = 'Гость';
    let userPhone: string | null = null;
    try {
      const userResult = await query<{ email: string | null; name: string | null; phone: string | null }>(
        'SELECT email, name, phone FROM users WHERE id = $1', [userId]
      );
      userEmail = userResult.rows[0]?.email ?? null;
      userName = userResult.rows[0]?.name || 'Гость';
      userPhone = userResult.rows[0]?.phone ?? null;
    } catch (err) {
      logStayFailure('book: контакты гостя не прочитаны', err);
    }

    // Уведомляем владельца объекта (MAX/Telegram) — раньше о брони знал только
    // гость (email), владелец узнавал, лишь зайдя в кабинет. Non-fatal.
    try {
      const ownerResult = await query<{ telegram_chat_id: string | null; max_chat_id: string | null }>(
        `SELECT p.telegram_chat_id, p.max_chat_id::text AS max_chat_id
         FROM accommodations a
         JOIN partners p ON a.partner_id = p.id
         WHERE a.id = $1`,
        [accommodationId]
      );
      await notifyNewStayBooking({
        bookingId,
        accommodationName: room.accommodation_name,
        roomName: room.name,
        checkInDate,
        checkOutDate,
        guests: adults + children,
        totalPrice,
        guestName: userName,
        guestPhone: userPhone,
        ownerTelegramChatId: ownerResult.rows[0]?.telegram_chat_id ?? null,
        ownerMaxChatId: ownerResult.rows[0]?.max_chat_id ?? null,
      });
    } catch (err) {
      logStayFailure('book: уведомление владельцу', err);
    }

    // Email гостю. Письмо ЧЕСТНОЕ: бронь в статусе pending — владелец её ещё
    // не подтвердил, и платит гость владельцу при заселении, а не платформе
    // (решение владельца 26.09). Ссылки на оплату здесь нет и быть не может.
    if (userEmail) {
      try {
        const sent = await emailService.sendEmail({
          to: userEmail,
          subject: safeSubject(`Заявка на бронирование принята: ${room.accommodation_name}`),
          html: `
          <h2>Заявка на бронирование принята</h2>
          <p>Владелец объекта подтвердит её в ближайшее время — мы сообщим.</p>
          <p><strong>Объект:</strong> ${escapeHtml(room.accommodation_name)}</p>
          <p><strong>Номер:</strong> ${escapeHtml(room.name)}</p>
          <p><strong>Заезд:</strong> ${checkInDate}</p>
          <p><strong>Выезд:</strong> ${checkOutDate}</p>
          <p><strong>Гости:</strong> ${adults} взрослых, ${children} детей</p>
          <p><strong>Итого:</strong> ${totalPrice.toLocaleString('ru-RU')} ₽</p>
          <p><strong>${STAY_PAY_ON_SITE}.</strong> Платформа деньги за проживание не принимает.</p>
          <p><strong>ID заявки:</strong> ${bookingId}</p>
          <p>Статус можно смотреть в личном кабинете, раздел «Мои проживания».</p>
        `
        });
        if (!sent.success) logStayFailure('book: письмо гостю не отправлено', sent.error);
      } catch (err) {
        logStayFailure('book: письмо гостю', err);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Заявка отправлена владельцу. ${STAY_PAY_ON_SITE}.`,
      data: {
        bookingId,
        accommodationName: room.accommodation_name,
        roomName: room.name,
        checkInDate,
        checkOutDate,
        nights,
        adults,
        children,
        priceBreakdown: {
          pricePerNight,
          nights,
          totalPrice,
          currency: 'RUB',
        },
        status: 'pending',
        // Оплата на месте: онлайн-платежа по брони жилья нет, ссылки на
        // оплату нет. Прежние paymentUrl (страница, которой не существовало)
        // и payment (платёж в таблицу, которой нет на проде) сняты.
        payment: 'on_site' as const,
        paymentNote: STAY_PAY_ON_SITE,
      },
    });
    
  } catch (error) {
    logStayFailure('book: бронь не создана', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Ошибка при создании бронирования',
      },
      { status: 500 }
    );
  }
}


