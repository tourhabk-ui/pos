/**
 * POST /api/payments/tochka/qr
 * Создаёт СБП QR-код для бронирования.
 * Вызывается со страницы брони (/booking-success, SbpQrPayment).
 *
 * Платить можно только бронь, подтверждённую оператором (решение владельца
 * 24.09: «заявка → подтверждение → оплата»). До 25.09 роут принимал только
 * `new` и `pending_payment`, а страница брони предлагает оплату только
 * `confirmed` и `pending_payment` — после подтверждения оператором СБП
 * отвечал 404, а чат Кузьмича выдавал QR на неподтверждённую заявку.
 *
 * Статус брони при выдаче QR НЕ меняется. Раньше QR переводил бронь в
 * `pending_payment`, а это слово значит больше, чем «QR выдан»: такую бронь
 * крон abandoned-bookings отменяет через сутки без оплаты, а счёт занятости
 * её мест не держит. Подтверждённая оператором бронь от просмотра QR не
 * должна ни терять места, ни отменяться сама.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createSBPQR, isTochkaConfigured, tochkaMissingEnv } from '@/lib/payments/tochka';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { PAYABLE_BOOKING_STATUSES } from '@/lib/bookings/success-view';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const Schema = z.object({
  bookingId: z.number().int().positive(),
});

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  if (!isTochkaConfigured()) {
    // Туристу — прежняя фраза: чего именно не хватает у нас, его не касается.
    // В ЛОГ — поимённо. Раньше этот 503 был молчаливым, и «СБП не работает»
    // приходилось разбирать пробами прода: по одному ответу нельзя было
    // отличить «переменных нет» от «банк отказал». Третье состояние здесь и
    // есть «мы не настроены», и оно обязано называть себя вслух.
    console.error('[tochka/qr] СБП не настроен, не заданы:', tochkaMissingEnv().join(', '));
    return NextResponse.json(
      { error: 'Оплата через СБП временно недоступна — обратитесь к оператору' },
      { status: 503 },
    );
  }

  try {
    const body = await req.json();
    const { bookingId } = Schema.parse(body);

    // Загружаем данные брони
    const { rows } = await pool.query<{
      final_price: number;
      title: string;
      tochka_qr_id: string | null;
      booking_status: string;
      paid_at: Date | null;
    }>(
      `SELECT ob.final_price, ot.title, ob.tochka_qr_id, ob.booking_status, ob.paid_at
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ob.id = $1 AND ob.deleted_at IS NULL
       LIMIT 1`,
      [bookingId],
    );

    if (!rows[0]) {
      return NextResponse.json({ error: 'Бронирование не найдено' }, { status: 404 });
    }

    const booking = rows[0];

    if (booking.paid_at) {
      return NextResponse.json({ error: 'Бронь уже оплачена', code: 'already_paid' }, { status: 409 });
    }
    if (booking.booking_status === 'new') {
      return NextResponse.json(
        { error: 'Оплата откроется после того, как оператор подтвердит бронь', code: 'not_confirmed' },
        { status: 409 },
      );
    }
    if (!PAYABLE_BOOKING_STATUSES.includes(booking.booking_status)) {
      return NextResponse.json({ error: 'Эту бронь оплатить нельзя', code: 'not_payable' }, { status: 409 });
    }

    // Один QR на бронь (как у мест, миграция 928): второй qrcId сделал бы
    // оплату по первому невидимой для приёмника. Истёкший QR — оплата картой.
    if (booking.tochka_qr_id) {
      return NextResponse.json({ error: 'Оплата уже создана для этой брони', code: 'qr_exists' }, { status: 409 });
    }

    const qr = await createSBPQR({
      amountRub:   Number(booking.final_price),
      description: `TourHab: ${booking.title} #${bookingId}`,
      ttlMinutes:  60,
      bookingId,
    });

    if (!qr) {
      return NextResponse.json({ error: 'Не удалось создать QR-код оплаты' }, { status: 502 });
    }

    // qrId — единственная связь оплаты с бронью: без него вебхук оплату не
    // найдёт. Раньше отказ записи глушился, и туристу отдавался QR, деньги по
    // которому пришли бы в никуда. Условие на пустой QR — от гонки двух вкладок.
    const attached = await pool.query(
      `UPDATE operator_bookings
       SET tochka_qr_id = $1, updated_at = NOW()
       WHERE id = $2 AND tochka_qr_id IS NULL AND paid_at IS NULL`,
      [qr.qrId, bookingId],
    );
    if (!attached.rowCount) {
      console.error('[tochka/qr] QR выпущен, но к брони не привязан:', `qr=${qr.qrId}`, `booking=${bookingId}`);
      return NextResponse.json({ error: 'Оплата уже создана для этой брони', code: 'qr_exists' }, { status: 409 });
    }

    return NextResponse.json({
      qrCode:    qr.qrCode,    // base64 PNG — показать как <img src="data:image/png;base64,...">
      qrLink:    qr.qrLink,    // deeplink для мобильных банков
      payload:   qr.payload,   // строка СБП для копирования
      expiresAt: qr.expiresAt,
      amount:    Number(booking.final_price),
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Некорректный номер брони' }, { status: 400 });
    }
    const e = err as { code?: string; message?: string };
    console.error('[tochka/qr] отказ выдачи QR:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ error: 'Не удалось создать QR-код оплаты' }, { status: 500 });
  }
}

// ── GET: статус оплаты (polling из фронта) ─────────────────────────

export async function GET(req: NextRequest) {
  const bookingId = req.nextUrl.searchParams.get('bookingId');
  if (!bookingId || !/^\d+$/.test(bookingId)) return NextResponse.json({ error: 'bookingId обязателен' }, { status: 400 });

  try {
    const { rows } = await pool.query<{
      booking_status: string;
      paid_at: Date | null;
    }>(
      `SELECT booking_status, paid_at FROM operator_bookings WHERE id = $1 LIMIT 1`,
      [bookingId],
    );

    const row = rows[0];
    if (!row) return NextResponse.json({ error: 'Не найдено' }, { status: 404 });

    // Оплачено — это записанная оплата, а не статус: `confirmed` ставит и
    // оператор, до всякой оплаты. Раньше опрос видел «оплачено» у любой
    // подтверждённой брони.
    return NextResponse.json({
      paid: row.paid_at !== null,
      status: row.booking_status,
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tochka/qr] опрос статуса:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ error: 'Ошибка' }, { status: 500 });
  }
}
