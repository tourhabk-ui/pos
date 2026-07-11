/**
 * POST /api/hub/bookings/create
 * Create new booking + уведомление оператору в Telegram
 */

import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { notifyNewBooking } from '@/lib/notifications/operator-booking';
import { emailService } from '@/lib/notifications/email-service';
import { createUonRequest } from '@/lib/integrations/uon';
import { verifyToken, extractToken } from '@/lib/auth/jwt';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

const bookingCreateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const BOOKING_ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND:    'Тур не найден или больше не доступен. Попробуйте выбрать другой тур.',
  DATE_PAST:    'Выбранная дата уже прошла. Укажите будущую дату.',
  DATE_BLOCKED: 'Оператор закрыл бронирование на эту дату. Выберите другую дату.',
  NO_SLOTS:     'На выбранную дату нет свободных мест. Выберите другую дату или свяжитесь с оператором.',
  MAX_EXCEEDED: 'Превышено максимальное число участников для этого тура.',
};

const BookingSchema = z.object({
  tour_id:            z.number().positive({ message: 'Укажите тур' }),
  tourist_name:       z.string().min(2, 'Имя: минимум 2 символа').max(255),
  tourist_email:      z.string().email('Неверный формат email').optional(),
  tourist_phone:      z.string().min(10, 'Телефон слишком короткий').max(20),
  participants_count: z.number().min(1, 'Минимум 1 участник').max(100),
  booking_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD'),
  special_requests:   z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!bookingCreateLimiter.check(ip)) {
    return NextResponse.json(
      { error: 'Слишком много запросов. Попробуйте через минуту.' },
      { status: 429 },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const parsed = BookingSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Неверные данные формы', field: first?.path?.[0] },
      { status: 400 },
    );
  }

  const data = parsed.data;

  if (new Date(data.booking_date) < new Date(new Date().toISOString().slice(0, 10))) {
    return NextResponse.json({ error: BOOKING_ERROR_MESSAGES.DATE_PAST }, { status: 422 });
  }

  // Гостевой чек-аут остаётся рабочим — авторизация опциональна (fail-open).
  // Если юзер залогинен, линкуем бронь к его аккаунту: без этого
  // lib/recommendations/engine.ts не может найти историю броней ни для кого.
  const cookieToken = req.cookies.get('auth_token')?.value;
  const headerToken = extractToken(req.headers.get('Authorization'));
  const token = cookieToken || headerToken;
  const authedUser = token ? await verifyToken(token) : null;
  const userId = authedUser?.userId ?? null;

  try {
    const result = await transaction(async (client) => {
      const tourResult = await client.query<{
        operator_id: string;
        title: string;
        base_price: number;
        max_participants: number | null;
        available_slots: number | null;
      }>(
        `SELECT ot.operator_id, ot.title, ot.base_price, ot.max_participants, ot.available_slots
         FROM operator_tours ot
         WHERE ot.id = $1 AND ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL FOR UPDATE`,
        [data.tour_id],
      );

      if (tourResult.rows.length === 0) {
        throw Object.assign(new Error(BOOKING_ERROR_MESSAGES.NOT_FOUND), { code: 'NOT_FOUND' });
      }

      const tour = tourResult.rows[0]!;

      // Календарь оператора (tour_availability) — опционален: нет строки на
      // дату = дата свободна (большинство операторов календарём не пользуются).
      // Но ЯВНАЯ блокировка (is_cancelled) или лимит слотов на дату должны
      // уважаться — раньше гейткипер календарь вообще не читал и принимал
      // брони на закрытые оператором даты.
      const calendarResult = await client.query<{ available_slots: number; is_cancelled: boolean }>(
        `SELECT available_slots, is_cancelled FROM tour_availability
         WHERE operator_tour_id = $1 AND date = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [data.tour_id, data.booking_date],
      );
      const calendarRow = calendarResult.rows[0] ?? null;

      if (calendarRow?.is_cancelled) {
        throw Object.assign(new Error(BOOKING_ERROR_MESSAGES.DATE_BLOCKED), { code: 'DATE_BLOCKED' });
      }

      // Эффективный лимит на дату: пересечение лимита тура и лимита календаря
      const capacityCap: number | null = calendarRow
        ? Math.min(tour.max_participants ?? calendarRow.available_slots, calendarRow.available_slots)
        : tour.max_participants;

      if (capacityCap != null && data.participants_count > capacityCap) {
        throw Object.assign(
          new Error(`${BOOKING_ERROR_MESSAGES.MAX_EXCEEDED} (максимум: ${capacityCap})`),
          { code: 'MAX_EXCEEDED' },
        );
      }

      // Count actual confirmed bookings for this date within the same transaction.
      // FOR UPDATE on the tour row above serialises concurrent requests, so this
      // read is consistent: no other booking for this tour can commit until we do.
      const slotCheckResult = await client.query<{ already_booked: string }>(
        `SELECT COALESCE(SUM(participants), 0) AS already_booked
         FROM operator_bookings
         WHERE operator_tour_id = $1
           AND booking_date = $2
           AND booking_status NOT IN ('cancelled', 'rejected')`,
        [data.tour_id, data.booking_date],
      );
      const alreadyBooked = parseInt(slotCheckResult.rows[0]!.already_booked, 10);

      if (capacityCap != null && alreadyBooked + data.participants_count > capacityCap) {
        const remaining = capacityCap - alreadyBooked;
        throw Object.assign(
          new Error(remaining <= 0
            ? BOOKING_ERROR_MESSAGES.NO_SLOTS
            : `Недостаточно мест на эту дату. Доступно: ${remaining}, запрашивается: ${data.participants_count}`),
          { code: 'NO_SLOTS' },
        );
      }

      const total_price = Number(tour.base_price) * data.participants_count;

      const bookingResult = await client.query<{ id: number }>(
        `INSERT INTO operator_bookings (
           operator_tour_id, tourist_name, tourist_email, tourist_phone,
           participants, booking_date, special_requests, booking_status,
           base_total_price, final_price, created_via, user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $8, 'website', $9)
         RETURNING id`,
        [
          data.tour_id,
          data.tourist_name,
          data.tourist_email ?? null,
          data.tourist_phone,
          data.participants_count,
          data.booking_date,
          data.special_requests ?? '',
          total_price,
          userId,
        ],
      );

      const bookingId = bookingResult.rows[0]!.id;
      return { bookingId, total_price, tour };
    });

    // Уведомление оператору + U-ON sync — fire-and-forget, не блокирует ответ
    void (async () => {
      try {
        const opRow = await pool.query<{ name: string; telegram_chat_id: string | null; max_chat_id: number | null; uon_api_key: string | null }>(
          `SELECT name, telegram_chat_id, max_chat_id, uon_api_key FROM partners WHERE id = $1 LIMIT 1`,
          [result.tour.operator_id],
        );
        const op = opRow.rows[0];

        // U-ON sync: if operator has API key, create request in their CRM
        if (op?.uon_api_key) {
          try {
            const uonId = await createUonRequest(op.uon_api_key, {
              tour_title:       result.tour.title,
              booking_date:     data.booking_date,
              participants:     data.participants_count,
              total_price:      result.total_price,
              tourist_name:     data.tourist_name,
              tourist_phone:    data.tourist_phone,
              tourist_email:    data.tourist_email,
              special_requests: data.special_requests,
              operator_id:      result.tour.operator_id,
              booking_id:       String(result.bookingId),
            });
            if (uonId != null) {
              await pool.query(
                `UPDATE operator_bookings SET uon_request_id = $1, uon_synced_at = NOW() WHERE id = $2`,
                [uonId, result.bookingId],
              );
            }
          } catch {
            // U-ON sync failure is non-fatal — booking already created
          }
        }

        await notifyNewBooking({
          booking_id:                String(result.bookingId),
          tour_title:                result.tour.title,
          tourist_name:              data.tourist_name,
          tourist_phone:             data.tourist_phone,
          tourist_email:             data.tourist_email,
          booking_date:              data.booking_date,
          participants:              data.participants_count,
          final_price:               result.total_price,
          operator_name:             op?.name ?? 'Оператор',
          operator_telegram_chat_id: op?.telegram_chat_id ?? undefined,
          operator_max_chat_id:      op?.max_chat_id ?? undefined,
          via:                       'website',
        });
      } catch {
        // Non-fatal
      }
    })();

    // Email туристу — fire-and-forget, не блокирует ответ
    if (data.tourist_email) {
      void emailService.sendEmail({
        to: data.tourist_email,
        subject: `Заявка принята: ${result.tour.title} — Ведар`,
        html: `
          <h2>Ваша заявка принята!</h2>
          <p><strong>Тур:</strong> ${result.tour.title}</p>
          <p><strong>Дата:</strong> ${data.booking_date}</p>
          <p><strong>Участники:</strong> ${data.participants_count}</p>
          <p><strong>Сумма к оплате:</strong> ${result.total_price.toLocaleString('ru-RU')} ₽</p>
          <p><strong>Номер заявки:</strong> ${result.bookingId}</p>
          <p>Для завершения бронирования перейдите по ссылке ниже и оплатите тур:</p>
          <p><a href="${getPublicBaseUrl()}/booking-success/${result.bookingId}">Оплатить тур</a></p>
          <p>Оператор также получил уведомление о вашей заявке и может связаться с вами.</p>
        `,
      }).catch(() => { /* non-fatal */ });
    }

    return NextResponse.json({
      id:          result.bookingId,
      booking_id:  result.bookingId,
      total_price: result.total_price,
      message:     'Заявка создана. Перед оплатой проверьте детали и условия тура.',
    });

  } catch (err) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException & { code?: string }).code;
      if (code && BOOKING_ERROR_MESSAGES[code]) {
        const status = code === 'NOT_FOUND' ? 404 : 422;
        return NextResponse.json({ error: err.message }, { status });
      }
    }
    return NextResponse.json(
      { error: 'Не удалось создать бронирование. Попробуйте позже или свяжитесь с оператором напрямую.' },
      { status: 500 },
    );
  }
}
