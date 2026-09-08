/**
 * POST /api/hub/bookings/create
 * Create new booking + уведомление оператору в Telegram
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { reserveBooking, ReserveError } from '@/lib/bookings/reserve';
import { reachForPartner } from '@/lib/partners/reach';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { notifyNewBooking } from '@/lib/notifications/operator-booking';
import { emailService } from '@/lib/notifications/email-service';
import { createUonRequest } from '@/lib/integrations/uon';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { getPublicBaseUrl } from '@/lib/config';
import { notifyTouristBookingCreated } from '@/lib/telegram/booking-notify';

export const dynamic = 'force-dynamic';

const bookingCreateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

/**
 * Дата в прошлом — единственная проверка, которая остаётся здесь: она о ФОРМЕ
 * запроса, а не о занятости тура. Все отказы по существу (нет тура, дата
 * закрыта оператором, мест не осталось) формулирует `reserveBooking` — там же,
 * где они устанавливаются, одинаково для формы и для Кузьмича.
 */
const DATE_PAST_MESSAGE = 'Выбранная дата уже прошла. Укажите будущую дату.';

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
    return NextResponse.json({ error: DATE_PAST_MESSAGE }, { status: 422 });
  }

  // Гостевой чек-аут остаётся рабочим — авторизация опциональна (fail-open).
  // Если юзер залогинен, линкуем бронь к его аккаунту: без этого
  // lib/recommendations/engine.ts не может найти историю броней ни для кого.
  // getUserFromRequest (не голый verifyToken) — чтобы отозванная сессия
  // (signout) не привязывала бронь чужому аккаунту по мёртвому токену.
  const authedUser = await getUserFromRequest(req);
  const userId = authedUser?.userId ?? null;

  try {
    // Бронь заводит общий модуль — тот же самый, которым бронирует Кузьмич.
    // Раньше здесь лежала своя копия транзакции, и копии разошлись: чат не
    // читал календарь оператора и писал другой статус. Ключ доступа
    // (миграция 943) отдаётся ОДИН раз — тому, кто бронь создал; номер брони
    // больше не открывает ни подтверждение, ни PDF.
    const result = await reserveBooking({
      tourId:          data.tour_id,
      touristName:     data.tourist_name,
      touristPhone:    data.tourist_phone,
      touristEmail:    data.tourist_email ?? null,
      participants:    data.participants_count,
      date:            data.booking_date,
      specialRequests: data.special_requests ?? '',
      createdVia:      'website',
      userId,
    });

    // Турист узнаёт, что заявка дошла. Раньше уведомление шло только
    // ОПЕРАТОРУ: человек отправлял бронь и молчал до подтверждения, а
    // Watchdog бьёт тревогу лишь через сутки. Функция для этого была написана
    // и не звалась ниоткуда (перепись 22.08.2026); её соседи о подтверждении
    // и отмене подключены давно.
    if (userId !== null) {
      notifyTouristBookingCreated(userId, {
        id: String(result.bookingId),
        tourTitle: String(result.tourTitle),
        date: new Date(data.booking_date),
        participants: data.participants_count,
        totalAmount: result.totalPrice,
      });
    }

    // Уведомление оператору + U-ON sync — fire-and-forget, не блокирует ответ
    void (async () => {
      try {
        // Адрес оператора — через общий модуль: он смотрит ОБЕ колонки.
        // Раньше здесь читался только partners.telegram_chat_id, и оператор,
        // у которого адрес записан в аккаунте человека, был для этого роута
        // «неподключённым», хотя бронь из чата Кузьмича до него доезжала.
        const [opRow, reach] = await Promise.all([
          pool.query<{ name: string; uon_api_key: string | null }>(
            `SELECT name, uon_api_key FROM partners WHERE id = $1 LIMIT 1`,
            [result.operatorId],
          ),
          reachForPartner(result.operatorId),
        ]);
        const op = opRow.rows[0];

        // U-ON sync: if operator has API key, create request in their CRM
        if (op?.uon_api_key) {
          try {
            const uonId = await createUonRequest(op.uon_api_key, {
              tour_title:       result.tourTitle,
              booking_date:     data.booking_date,
              participants:     data.participants_count,
              total_price:      result.totalPrice,
              tourist_name:     data.tourist_name,
              tourist_phone:    data.tourist_phone,
              tourist_email:    data.tourist_email,
              special_requests: data.special_requests,
              operator_id:      result.operatorId,
              booking_id:       String(result.bookingId),
            });
            if (uonId != null) {
              await pool.query(
                `UPDATE operator_bookings SET uon_request_id = $1, uon_synced_at = NOW() WHERE id = $2`,
                [uonId, result.bookingId],
              );
            }
          } catch (err) {
            // Не фатально для брони, но у оператора своя CRM: не доехало —
            // заявки в ней нет, и оператор работает по неполной картине.
            console.error(
              '[bookings/create] синк U-ON не прошёл, бронь',
              String(result.bookingId),
              err instanceof Error ? err.message : err,
            );
          }
        }

        await notifyNewBooking({
          booking_id:                String(result.bookingId),
          tour_title:                result.tourTitle,
          tourist_name:              data.tourist_name,
          tourist_phone:             data.tourist_phone,
          tourist_email:             data.tourist_email,
          booking_date:              data.booking_date,
          participants:              data.participants_count,
          final_price:               result.totalPrice,
          operator_name:             op?.name ?? 'Оператор',
          operator_telegram_chat_id: reach?.telegramChatId ?? undefined,
          operator_max_chat_id:      reach?.maxChatId ?? undefined,
          via:                       'website',
        });

        // Адреса нет ни одного — заявка легла в базу и никуда не поехала.
        // Молчать об этом нельзя: Watchdog через 48 часов запишет это как
        // «оператор игнорирует бронь», хотя оператору никто не писал (§4.0).
        if (reach && !reach.reachable) {
          console.error(
            '[bookings/create] у оператора нет ни Telegram, ни MAX — заявка не отправлена, бронь',
            String(result.bookingId),
          );
        }
      } catch (err) {
        // Не фатально для брони — она уже в базе, — но и не бесследно.
        // Пустой catch здесь означал: заявка есть, оператор о ней не знает, и
        // это неотличимо от «оператор знает и не отвечает». Первое чинит нас,
        // второе — оператора; путать их дорого (§4.0).
        console.error(
          '[bookings/create] уведомление оператору не отправлено, бронь',
          String(result.bookingId),
          err instanceof Error ? err.message : err,
        );
      }
    })();

    // Email туристу — fire-and-forget, не блокирует ответ
    if (data.tourist_email) {
      void emailService.sendEmail({
        to: data.tourist_email,
        subject: `Заявка принята: ${result.tourTitle} — Ведар`,
        html: `
          <h2>Ваша заявка принята!</h2>
          <p><strong>Тур:</strong> ${result.tourTitle}</p>
          <p><strong>Дата:</strong> ${data.booking_date}</p>
          <p><strong>Участники:</strong> ${data.participants_count}</p>
          <p><strong>Сумма к оплате:</strong> ${result.totalPrice.toLocaleString('ru-RU')} ₽</p>
          <p><strong>Номер заявки:</strong> ${result.bookingId}</p>
          <p>Для завершения бронирования перейдите по ссылке ниже и оплатите тур:</p>
          <p><a href="${getPublicBaseUrl()}/booking-success/${result.bookingId}?t=${result.accessToken}">Оплатить тур</a></p>
          <p>Оператор также получил уведомление о вашей заявке и может связаться с вами.</p>
        `,
      }).catch((err: unknown) => {
        // Это письмо — единственное, что возвращает туриста к оплате: ссылка
        // на /booking-success живёт только в нём. Молча потерять его значит
        // молча потерять продажу.
        console.error(
          '[bookings/create] письмо туристу не ушло, бронь',
          String(result.bookingId),
          err instanceof Error ? err.message : err,
        );
      });
    }

    return NextResponse.json({
      id:           result.bookingId,
      booking_id:   result.bookingId,
      access_token: result.accessToken,
      total_price:  result.totalPrice,
      message:     'Заявка создана. Перед оплатой проверьте детали и условия тура.',
    });

  } catch (err) {
    // Отказ по существу: тур снят, дата закрыта, мест нет. Текст приходит из
    // общего модуля — тот же самый, что услышит турист в чате у Кузьмича.
    if (err instanceof ReserveError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.code === 'NOT_FOUND' ? 404 : 422 },
      );
    }
    console.error(
      '[bookings/create] бронь не заведена, тур',
      String(data.tour_id),
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: 'Не удалось создать бронирование. Попробуйте позже или свяжитесь с оператором напрямую.' },
      { status: 500 },
    );
  }
}
