/**
 * POST /api/payments/tochka/webhook
 * Точка Bank вызывает этот endpoint при успешной оплате по QR.
 *
 * Настройка вебхука: ЛК Точки → Интеграции → Уведомления →
 *   URL: https://vedarai.ru/api/payments/tochka/webhook
 *   События: payment.completed
 *
 * Доверие: тело запроса НЕ является доказательством оплаты. qrcId уезжает
 * клиенту вместе с QR (qrLink = qr.nspk.ru/<qrcId>), поэтому payload может
 * подделать любой плательщик. Факт и сумму спрашиваем у самой Точки
 * (getSBPPaymentStatus) и сверяем с final_price брони — как это давно
 * сделано в CloudPayments-вебхуке (HMAC + сверка суммы).
 *
 * Ответ 200 = «больше не присылай». Раньше маршрут отвечал 200 ВСЕГДА, включая
 * `catch`: падение записи означало, что деньги пришли, бронь навсегда осталась
 * в `pending_payment`, а банк считал уведомление принятым и не повторял его.
 * Тот же разрыв был при недоступном банке — комментарий обещал «лучше повтор
 * вебхука», а код возвращал 200 и повтор запрещал. Теперь 200 только там, где
 * повторять действительно нечего; всё, что мы не сумели довести до записи, —
 * 503 с повтором.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getSBPPaymentStatus } from '@/lib/payments/tochka';
import { recordCommissionFromBooking } from '@/lib/payments/commission';

export const dynamic = 'force-dynamic';

interface TochkaWebhookPayload {
  event:    string;           // "payment.completed"
  qrcId:    string;           // ID QR-кода = tochka_qr_id в нашей БД
  amount:   number;           // в копейках
  currency: string;
  transactionDate: string;
  order?:   string;           // booking_id который мы передавали при создании QR
}

/** Повторить позже: мы не смогли довести оплату до записи. */
function retryLater(reason: string) {
  return NextResponse.json({ ok: false, retry: true, reason }, { status: 503 });
}

export async function POST(req: NextRequest) {
  let payload: TochkaWebhookPayload;
  try {
    payload = await req.json() as TochkaWebhookPayload;
  } catch {
    // Тело не разобрать — повтор того же тела ничего не изменит.
    return NextResponse.json({ ok: true, parsed: false });
  }

  if (payload.event !== 'payment.completed') {
    return NextResponse.json({ ok: true }); // игнорируем другие события
  }

  const qrId = payload.qrcId;
  if (!qrId) return NextResponse.json({ ok: true });

  try {
    // Находим бронирование по qrId
    const { rows } = await pool.query<{ id: number; final_price: number; tourist_name: string }>(
      `SELECT id, final_price, tourist_name
       FROM operator_bookings
       WHERE tochka_qr_id = $1 AND booking_status = 'pending_payment'
       LIMIT 1`,
      [qrId],
    );

    if (!rows[0]) {
      // Уже обработано или не найдено — возвращаем 200 чтобы Точка не повторяла
      return NextResponse.json({ ok: true });
    }

    const booking = rows[0];

    // Спрашиваем у Точки, что реально произошло с этим QR.
    const status = await getSBPPaymentStatus(qrId);

    // Банк не ответил (недоступен, нет токена, нет TOCHKA_MERCHANT_ID) — мы НЕ
    // знаем, оплачено ли. Это не «не оплачено», а «не выяснили»: просим повтор.
    if (!status) return retryLater('bank_status_unavailable');

    // Банк ответил, но платёж не прошёл — повторять нечего.
    if (status.status !== 'paid') {
      return NextResponse.json({ ok: true, confirmed: false });
    }

    // Сумма — из банка (или из брони, если банк её не вернул), не из тела запроса.
    const expected = Number(booking.final_price);
    const paidAmount = status.amount ?? expected;
    if (Math.abs(paidAmount - expected) > 1) {
      // Расхождение суммы не чинится повтором, но и молчать о нём нельзя:
      // это единственное место, где видно, что банк принял не ту сумму.
      notifyOwnerAmountMismatch(booking.id, expected, paidAmount).catch(() => {});
      return NextResponse.json({ ok: true, confirmed: false });
    }
    const paidAt = status.paidAt ?? new Date();

    // Подтверждаем бронирование. Условие по статусу в WHERE — идемпотентность
    // при повторной доставке вебхука. Упадёт — уйдём в 503 общим catch: деньги
    // пришли, и потерять это тише, чем попросить повтор, нельзя.
    await pool.query(
      `UPDATE operator_bookings
       SET booking_status = 'confirmed',
           paid_at = $1,
           paid_amount = $2,
           updated_at = NOW()
       WHERE id = $3 AND booking_status = 'pending_payment'`,
      [paidAt, paidAmount, booking.id],
    );

    // Ниже — работа ПОСЛЕ подтверждения. Отсюда 503 возвращать уже нельзя:
    // повтор увидит бронь не в pending_payment и просто уйдёт в 200, ничего не
    // доделав. Поэтому каждый шаг гасит свою ошибку сам.
    await afterConfirmed(booking.id, booking.tourist_name, paidAmount, qrId);

    return NextResponse.json({ ok: true });

  } catch {
    return retryLater('processing_failed');
  }
}

/**
 * Учёт и уведомления после подтверждения оплаты. Ошибки не выпускаются наружу:
 * платёж уже записан, а повтор вебхука сюда всё равно не дойдёт.
 */
async function afterConfirmed(bookingId: number, touristName: string, paidAmount: number, qrId: string) {
  // Комиссия платформы. До 04.08 СБП-оплата шла мимо учёта вовсе: комиссию
  // писали только два вебхука CloudPayments, а Точка — третий живой приёмник
  // (QR выдаётся из чата Кузьмича). Ставка договорная, из базы; вставка
  // идемпотентна по invoice_id, поэтому ключ — сам QR, уникальный на оплату.
  await recordCommissionFromBooking(bookingId, `tochka:${qrId}`);

  // Счётчик занятости в календаре оператора (доступность считается из реальных
  // броней, но счётчик показывается оператору и без этого разъезжается).
  await pool.query(
    `UPDATE tour_availability ta
     SET booked_slots = booked_slots + b.participants,
         updated_at = NOW()
     FROM operator_bookings b
     WHERE b.id = $1
       AND ta.operator_tour_id = b.operator_tour_id
       AND ta.date = b.booking_date`,
    [bookingId],
  ).catch(() => {});

  // Пишем в лог AI-действий для аналитики
  await pool.query(
    `INSERT INTO ai_actions_log (action_type, provider, metadata, created_at)
     VALUES ('payment_confirmed', 'tochka_sbp', $1, NOW())`,
    [JSON.stringify({ bookingId, amount: paidAmount, qrId })],
  ).catch(() => {});

  // Уведомление оператору через Telegram (fire-and-forget)
  notifyOperator(bookingId, touristName, paidAmount).catch(() => {});
}

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!token || !ownerId) return;

  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ownerId, text, parse_mode: 'HTML' }),
  });
}

async function notifyOperator(bookingId: number, touristName: string, amount: number) {
  await sendTelegram([
    'Оплата получена через СБП',
    '',
    `Бронирование: #${bookingId}`,
    `Турист: ${touristName}`,
    `Сумма: ${amount.toLocaleString('ru-RU')} р.`,
    '',
    `tourhab.ru/hub/operator/bookings`,
  ].join('\n'));
}

async function notifyOwnerAmountMismatch(bookingId: number, expected: number, paid: number) {
  await sendTelegram([
    'СБП: сумма оплаты не совпала с бронью — бронь НЕ подтверждена',
    '',
    `Бронирование: #${bookingId}`,
    `Ожидалось: ${expected.toLocaleString('ru-RU')} р.`,
    `Пришло: ${paid.toLocaleString('ru-RU')} р.`,
  ].join('\n'));
}
