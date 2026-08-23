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
    const confirmed = await pool.query(
      `UPDATE operator_bookings
       SET booking_status = 'confirmed',
           payment_status = 'paid',
           paid_at = $1,
           paid_amount = $2,
           updated_at = NOW()
       WHERE id = $3 AND booking_status = 'pending_payment'`,
      [paidAt, paidAmount, booking.id],
    );

    // Ноль строк здесь — не мелочь и не идемпотентность «сама собой». Между
    // SELECT выше и этим UPDATE мы УХОДИЛИ СПРАШИВАТЬ БАНК, а это сетевой
    // вызов; за это время бронь могла уйти из pending_payment. Раньше результат
    // не проверялся вовсе, и дальше безусловно шёл afterConfirmed: комиссия
    // начислялась, оператору уходило «оплата получена», а на самой броне не
    // было ни paid_at, ни статуса. Деньги у банка — записи нет.
    if (confirmed.rowCount === 0) {
      return await handleLostRace(booking.id, paidAt, paidAmount, qrId);
    }

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
 * Бронь ушла из `pending_payment`, пока мы спрашивали банк. Разбирается по
 * тому, КУДА она ушла, потому что это два разных события:
 *
 *   confirmed — вебхук доставлен повторно, всё уже записано первым проходом.
 *               Отвечаем 200: повторять нечего, второй раз начислять комиссию
 *               нельзя.
 *   прочее    — чаще всего `cancelled` от авто-отмены (крон abandoned-bookings)
 *               или отказ оператора. Деньги при этом У БАНКА. Молчать нельзя, и
 *               подтверждать самовольно тоже нельзя: отменённая бронь могла
 *               быть отменена по делу, а решение о возврате принимает человек.
 *               Поэтому записываем ФАКТ оплаты (payment_status, paid_at,
 *               paid_amount), статус брони не трогаем, зовём владельца.
 *               Комиссию не начисляем: она берётся с состоявшейся брони.
 *
 * После записи факта крон отмены эту строку больше не тронет — его условие
 * отказывается от броней с `paid_at`.
 */
async function handleLostRace(bookingId: number, paidAt: Date, paidAmount: number, qrId: string) {
  const { rows } = await pool.query<{ booking_status: string; paid_at: Date | null }>(
    `SELECT booking_status, paid_at FROM operator_bookings WHERE id = $1`,
    [bookingId],
  );
  const state = rows[0];

  // Строки нет вовсе — это не «оплата не наша», это «мы не знаем, что с
  // бронью». Просим повтор: за это время строка может вернуться из реплики.
  if (!state) return retryLater('booking_vanished');

  if (state.booking_status === 'confirmed') {
    return NextResponse.json({ ok: true, confirmed: true, repeat: true });
  }

  await pool.query(
    `UPDATE operator_bookings
     SET payment_status = 'paid',
         paid_at        = COALESCE(paid_at, $1),
         paid_amount    = $2,
         updated_at     = NOW()
     WHERE id = $3`,
    [paidAt, paidAmount, bookingId],
  );

  console.error(
    '[tochka/webhook] оплата пришла на бронь вне pending_payment:',
    `booking=${bookingId}`, `status=${state.booking_status}`, `qr=${qrId}`,
  );
  notifyOwnerPaidAfterExit(bookingId, state.booking_status, paidAmount).catch(() => {});

  return NextResponse.json({
    ok: true,
    confirmed: false,
    reason: 'booking_left_pending',
    booking_status: state.booking_status,
  });
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

async function notifyOwnerPaidAfterExit(bookingId: number, status: string, amount: number) {
  await sendTelegram([
    'СБП: деньги пришли на бронь, которая уже не ждёт оплаты',
    '',
    `Бронирование: #${bookingId}`,
    `Статус брони: ${status}`,
    `Оплачено: ${amount.toLocaleString('ru-RU')} р.`,
    '',
    'Факт оплаты записан, статус брони не менялся.',
    'Решение — подтвердить или вернуть деньги — за человеком.',
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
