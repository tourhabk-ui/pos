/**
 * POST /api/hub/bookings/create
 * Create new booking + уведомление оператору в Telegram
 */

import { NextRequest, NextResponse } from 'next/server';
import { reserveBooking, ReserveError } from '@/lib/bookings/reserve';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { notifyOperatorOfNewBooking } from '@/lib/bookings/notify-operator';
import { emailService } from '@/lib/notifications/email-service';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { getPublicBaseUrl } from '@/lib/config';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
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
  // coerce: id тура — bigint, и pg отдаёт его строкой; форма шлёт то, что
  // получила (#1769: 400 «expected number, received string» у всех заявок).
  tour_id:            z.coerce.number().int().positive({ message: 'Укажите тур' }),
  tourist_name:       z.string().min(2, 'Имя: минимум 2 символа').max(255),
  tourist_email:      z.string().email('Неверный формат email').optional(),
  tourist_phone:      z.string().min(10, 'Телефон слишком короткий').max(20),
  participants_count: z.number().min(1, 'Минимум 1 участник').max(100),
  booking_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD'),
  special_requests:   z.string().max(2000).optional(),
  /**
   * Согласие на обработку ПД — ОПЦИОНАЛЬНО, и это не послабление.
   *
   * У эндпоинта пять клиентов: форма тура, корзина, Кузьмич, виджет Кузьмича
   * и `/p/[code]`. Форма с галочкой есть ровно у первого; жёсткое
   * `z.literal(true)`, как на `/api/leads`, сломало бы четырёх разом.
   *
   * Отсутствие согласия записывается как NULL — «не спрашивали», а не
   * «отказано» (§4.0). Различить их в базе можно запросом, а выдать молчание
   * бота за согласие человека нельзя.
   */
  pd_consent:         z.boolean().optional(),
  /**
   * Код агентской ссылки (`KH-AGT-...`), пойманный ReferralCapture и
   * запомненный на 30 дней. Живость кода решает reserveBooking внутри
   * транзакции: плохой код даёт бронь без атрибуции, а не отказ туристу.
   */
  referral_code:      z.string().trim().max(32).optional(),
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
    // Свои сообщения — русские; у ошибок типа Zod пишет по-английски, и
    // турист видел «Invalid input: expected number…» (§4: понятные сообщения).
    const message = first && first.code === 'invalid_type'
      ? `Поле «${String(first.path?.[0] ?? '')}» заполнено неверно`
      : first?.message ?? 'Неверные данные формы';
    return NextResponse.json(
      { error: message, field: first?.path?.[0] },
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
      // Обстоятельства согласия, а не булево: время, адрес, канал и версия
      // формулировки. buildConsentRecord вернёт null, когда галочки не было —
      // у Кузьмича и виджета её нет вовсе, и это честное «не спрашивали».
      pdConsent:       buildConsentRecord(data.pd_consent, ip, 'web-form'),
      referralCode:    data.referral_code ?? null,
    });

    // Турист узнаёт, что заявка дошла. Раньше уведомление шло только
    // ОПЕРАТОРУ: человек отправлял бронь и молчал до подтверждения, а
    // Watchdog бьёт тревогу лишь через сутки. Функция для этого была написана
    // и не звалась ниоткуда (перепись 22.08.2026); её соседи о подтверждении
    // и отмене подключены давно.
    if (userId !== null) {
      // accessToken — тот же ключ, что уходит письмом (#1889): без него
      // ссылка на оплату из Telegram-уведомления вела бы в тупик, хотя
      // канал доставки есть.
      notifyTouristBookingCreated(userId, {
        id: String(result.bookingId),
        tourTitle: String(result.tourTitle),
        date: new Date(data.booking_date),
        participants: data.participants_count,
        totalAmount: result.totalPrice,
        accessToken: result.accessToken,
      });
    }

    // Уведомление оператору + U-ON sync — fire-and-forget, не блокирует ответ.
    // Хвост общий с запросом мест (lib/bookings/notify-operator): копия этого
    // кода во второй двери уже однажды осталась без уведомления оператору.
    void notifyOperatorOfNewBooking({
      bookingId:       result.bookingId,
      operatorId:      result.operatorId,
      tourTitle:       result.tourTitle,
      date:            data.booking_date,
      participants:    data.participants_count,
      totalPrice:      result.totalPrice,
      touristName:     data.tourist_name,
      touristPhone:    data.tourist_phone,
      touristEmail:    data.tourist_email,
      specialRequests: data.special_requests,
      via:             'website',
    });

    // Email туристу — fire-and-forget, не блокирует ответ
    if (data.tourist_email) {
      void emailService.sendEmail({
        to: data.tourist_email,
        subject: `Заявка №${result.bookingId} — ${result.tourTitle}`,
        // Письмо — носитель политики, а не квитанция. До 14.09 оно говорило
        // «перейдите по ссылке и ОПЛАТИТЕ ТУР» кнопкой «Оплатить тур» — то
        // есть торопило с оплатой ДО того, как оператор подтвердил дату. На
        // форме при этом написано обратное: «сначала фиксируем заявку, условия
        // подтверждаются перед оплатой». Два голоса об одном, и громче звучал
        // тот, который человек читает без нас.
        html: `
          <h2>Заявка принята</h2>
          <p><strong>Номер заявки:</strong> ${result.bookingId}</p>
          <p><strong>Тур:</strong> ${result.tourTitle}</p>
          <p><strong>Дата:</strong> ${data.booking_date}</p>
          <p><strong>Участники:</strong> ${data.participants_count}</p>
          <p><strong>Сумма:</strong> ${result.totalPrice.toLocaleString('ru-RU')} ₽</p>
          <p>Оператор получил заявку и свяжется с вами, чтобы подтвердить дату и детали поездки.</p>
          <p><a href="${getPublicBaseUrl()}/booking-success/${result.bookingId}?t=${result.accessToken}">Открыть заявку</a></p>
          <p>Сохраните эту ссылку: по одному номеру заявка не открывается. Оплатить можно будет на этой же странице — оператор всё равно подтвердит детали.</p>
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
