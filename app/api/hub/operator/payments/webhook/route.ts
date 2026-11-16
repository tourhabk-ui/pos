/**
 * POST /api/hub/operator/payments/webhook
 * CloudPayments webhook for operator tour bookings
 * Used by operator's own CloudPayments merchant account
 */

import { NextRequest, NextResponse } from 'next/server';
import { processCloudPaymentsWebhook, CloudPaymentsWebhook } from '@/lib/payments/cloudpayments-webhook';
import { notifyBookingPaid } from '@/lib/notifications/operator-booking';
import { recordCommissionFromBooking } from '@/lib/payments/commission';
import { holdTourPayment } from '@/lib/payments/hold-tour-payment';
import { query, transaction } from '@/lib/database';
import { canOfferPayment } from '@/lib/bookings/success-view';
import { reportPaidUnconfirmed } from '@/lib/payments/paid-unconfirmed-alert';
import { reportPaymentAnomaly } from '@/lib/payments/payment-anomaly-alert';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let webhookData: CloudPaymentsWebhook | null = null;

  try {
    const body = await request.text();
    const signature = request.headers.get('X-Content-HMAC');

    const validation = await processCloudPaymentsWebhook(body, signature);
    if (!validation.success) {
      return NextResponse.json({ code: 13, message: validation.error || 'Invalid webhook' }, { status: 400 });
    }

    webhookData = validation.data as CloudPaymentsWebhook;
    // Счёт этого приёмника — номер брони. Чужой вид номера повтором не
    // исправится: строка в лог, банку — «принято».
    if (!/^\d+$/.test(String(webhookData.InvoiceId))) {
      console.error('[operator-payments-webhook] номер счёта — не номер брони, уведомление не записано:', `status=${webhookData.Status}`);
      if (webhookData.Status === 'Completed') {
        await reportPaymentAnomaly('operator-payments-webhook', { kind: 'unmatched', provider: 'CloudPayments', paid: webhookData.Amount });
      }
      return NextResponse.json({ code: 0 });
    }
    const bookingId = BigInt(webhookData.InvoiceId);

    switch (webhookData.Status) {
      case 'Completed':
        await handlePaid(bookingId, webhookData);
        break;
      case 'Declined':
      case 'Cancelled':
        await handleFailed(bookingId, webhookData);
        break;
      case 'Pending':
        await handlePending(bookingId, webhookData);
        break;
    }

    // CloudPayments requires code: 0 on success
    return NextResponse.json({ code: 0 });
  } catch (error) {
    // Сюда доходит только то, что повтор может исправить: отказ базы,
    // блокировка, сеть. Отвечаем 500 — CloudPayments повторит, а повтор
    // идемпотентен (бронь читается под FOR UPDATE). Раньше здесь был
    // `code: 0` на всё: отказ базы терял оплату — деньги взяты, бронь не
    // помечена, повтора не будет (#3433 п. 2, как у основного приёмника).
    // Бронь не найдена и не та сумма — не исключения, а свои исходы с
    // тревогой человеку (handlePaid).
    const e = error as { code?: string; message?: string };
    console.error(
      '[operator-payments-webhook] отказ обработки, CloudPayments повторит:',
      `invoice=${webhookData?.InvoiceId ?? 'нет'}`,
      `status=${webhookData?.Status ?? 'нет'}`,
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.message ?? String(error),
    );
    return NextResponse.json({ code: 13, message: 'Internal error' }, { status: 500 });
  }
}

async function handlePaid(bookingId: bigint, webhook: CloudPaymentsWebhook) {
  // Три записи одной оплаты — бронь, платёж, занятость — обязаны примениться
  // ВМЕСТЕ или никак. Раньше это были три отдельных query() без транзакции:
  // падение между UPDATE брони и INSERT платежа оставляло бронь confirmed, а
  // деньги неучтёнными (issue #1318). Тот же разрыв — гонка двух вебхуков:
  // CloudPayments намеренно шлёт дубли, и оба проходили проверку «ещё не
  // оплачено» до того, как первый её закрывал.
  //
  // Блокирующее чтение (FOR UPDATE, без NOWAIT) сериализует дубли: второй
  // вебхук ждёт первого, видит payment_status='paid' и тихо выходит. NOWAIT
  // здесь хуже — он вернул бы дублю ошибку блокировки (ложный отказ), тогда
  // как правильный исход дубля — no-op, а не сбой.
  const inserted = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT final_price, payment_status, booking_status, payment_id, paid_at
         FROM operator_bookings
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [bookingId],
    );
    // Брони нет — повтор не поможет: тревога человеку ниже, банку — «принято».
    if (locked.rows.length === 0) return { kind: 'unmatched' as const };
    const booking = locked.rows[0] as {
      final_price: string; payment_status: string; booking_status: string | null;
      payment_id: string | null; paid_at: Date | null;
    };

    // Идемпотентность под блокировкой: решение читается уже после того, как
    // строка закреплена за нами, поэтому «уже оплачено» — окончательный факт,
    // а не гонка. Повтор той же операции — no-op; другая операция по
    // оплаченной брони — деньги взяты дважды (#3433 п. 2).
    if (booking.payment_status === 'paid' || booking.paid_at) {
      return booking.payment_id === webhook.TransactionId.toString()
        ? { kind: 'duplicate' as const }
        : { kind: 'second_payment' as const, expected: parseFloat(booking.final_price) };
    }

    // Защита от подмены суммы в вебхуке — на закреплённой строке. Раньше —
    // исключение и `code: 0`: деньги взяты, человек не знал.
    const expectedAmount = parseFloat(booking.final_price);
    if (Math.abs(expectedAmount - webhook.Amount) > 1) {
      return { kind: 'amount_mismatch' as const, expected: expectedAmount };
    }

    await client.query(
      `UPDATE operator_bookings
       SET payment_status = 'paid',
           -- Подтверждает оператор, не оплата: неподтверждённая бронь
           -- остаётся в своём статусе (04.10), см. reportPaidUnconfirmed.
           booking_status = CASE WHEN booking_status IN ('confirmed', 'pending_payment')
                                 THEN 'confirmed' ELSE booking_status END,
           payment_id = $2,
           paid_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND payment_status != 'paid'`,
      [bookingId, webhook.TransactionId.toString()],
    );

    // Платёж в tour_payments (HELD до конца тура + 36ч) — общей дверью
    // lib/payments/hold-tour-payment. До 25.09 здесь стоял свой INSERT с
    // ON CONFLICT без предиката частичного индекса: 42P10 на каждой оплате,
    // и вся транзакция откатывалась.
    await holdTourPayment(client, bookingId, {
      transactionId: webhook.TransactionId.toString(),
      invoiceId: webhook.InvoiceId,
      method: webhook.CardType ?? 'card',
    });

    // Занятость — в той же транзакции: слот не может подтвердиться отдельно от
    // платежа. Раньше это был четвёртый independent query после комиссии.
    await client.query(
      `UPDATE tour_availability ta
       SET booked_slots = booked_slots + b.participants,
           updated_at = NOW()
       FROM operator_bookings b
       WHERE b.id = $1
         AND ta.operator_tour_id = b.operator_tour_id
         AND ta.date = b.booking_date`,
      [bookingId],
    );

    // Комиссия — в той же транзакции, что оплата (#3433 п. 2): после коммита
    // её терял упавший процесс, а повтор уведомления видел «уже оплачено».
    // С неподтверждённой брони не берётся — решает человек.
    if (canOfferPayment(booking.booking_status)) {
      await recordCommissionFromBooking(bookingId, webhook.InvoiceId, client);
    }

    return { kind: 'paid' as const, before: booking.booking_status };
  });

  // Дубль — дальше идти незачем: комиссия и уведомление уже были.
  if (inserted.kind === 'duplicate') return;
  if (inserted.kind !== 'paid') {
    await reportPaymentAnomaly('operator-payments-webhook', {
      kind: inserted.kind,
      provider: 'CloudPayments',
      bookingId: inserted.kind === 'unmatched' ? null : bookingId,
      expected: inserted.kind === 'unmatched' ? null : inserted.expected,
      paid: webhook.Amount,
    });
    return;
  }

  // Деньги пришли на бронь, которую нельзя было платить (обычно её отклоняет
  // Check до списания, /api/payments/check). Факт оплаты записан выше; бронь
  // не подтверждаем, комиссию не начисляем — решает человек.
  if (!canOfferPayment(inserted.before)) {
    await reportPaidUnconfirmed('operator-payments-webhook', bookingId, inserted.before, webhook.Amount);
    return;
  }

  // Комиссия начислена выше, в транзакции оплаты. Раньше этот вебхук её НЕ
  // начислял вовсе: попадёт ли оплата в учёт комиссий, зависело от того, какой
  // из двух URL прописан в кабинете CloudPayments (аудит дублей 03.08).

  // Уведомление оператора и админа.
  //
  // Оператор тура — это ПАРТНЁР: operator_tours.operator_id ссылается на
  // partners.id внешним ключом (operator_tours_operator_id_fkey). Прежняя
  // строка `LEFT JOIN users u ON t.operator_id = u.id` была основана на
  // догадке «оператор может быть и там, и там» и не совпадала никогда:
  // сравнивались id партнёра и id пользователя. Контакт человека берём
  // через partners.user_id.
  const res = await query(
    `SELECT t.title,
            ob.tourist_name,
            ob.tourist_phone,
            ob.booking_date,
            ob.participants,
            COALESCE(p.contacts->>'telegram_chat_id', u.telegram_id::text) AS telegram_chat_id,
            p.max_chat_id::text AS max_chat_id
     FROM operator_bookings ob
     JOIN operator_tours t ON ob.operator_tour_id = t.id
     LEFT JOIN partners p ON t.operator_id = p.id
     LEFT JOIN users    u ON u.id = p.user_id
     WHERE ob.id = $1 LIMIT 1`,
    [bookingId]
  );
  if (res.rows.length > 0) {
    const row = res.rows[0];
    notifyBookingPaid(
      bookingId,
      row.title as string,
      webhook.Amount,
      row.telegram_chat_id as string | undefined,
      row.tourist_name as string | undefined,
      row.tourist_phone as string | undefined,
      // Имя и телефон туриста уходят в MAX; в Telegram — заглушка без них.
      row.max_chat_id as string | null | undefined,
    ).catch((err: unknown) => logSwallowedFailure('operator-payments-webhook', 'уведомление об оплате', err));
  }
}

/**
 * Отказ или отмена платежа (#3433 п. 2). Раньше отменяли БРОНЬ без условия:
 * турист ошибся картой — подтверждённая бронь оператора отменена; отклонённая
 * повторная попытка после успешной оплаты отменяла ОПЛАЧЕННУЮ бронь, деньги
 * оставались HELD. Теперь отказ меняет только отметку платежа и только пока
 * оплаты нет: статус брони — дело оператора, турист может заплатить снова.
 * Отмена по уже оплаченной брони — тревога человеку: не вернули ли деньги.
 */
async function handleFailed(bookingId: bigint, webhook: CloudPaymentsWebhook) {
  const res = await query<{ paid: boolean }>(
    `WITH b AS (
       SELECT id, (paid_at IS NOT NULL OR payment_status = 'paid') AS paid
         FROM operator_bookings WHERE id = $1 AND deleted_at IS NULL
     ), upd AS (
       UPDATE operator_bookings ob SET payment_status = 'failed', updated_at = NOW()
         FROM b WHERE ob.id = b.id AND NOT b.paid
     )
     SELECT paid FROM b`,
    [bookingId.toString()],
  );
  if (res.rows[0]?.paid && webhook.Status === 'Cancelled') {
    await reportPaymentAnomaly('operator-payments-webhook', {
      kind: 'refused_after_paid', provider: 'CloudPayments', bookingId, paid: webhook.Amount,
    });
  }
}

/**
 * Платёж в ожидании — только пока оплаты нет: поздний Pending не переписывает
 * «оплачено» (порядок уведомлений банк не гарантирует).
 */
async function handlePending(bookingId: bigint, _webhook: CloudPaymentsWebhook) {
  await query(
    `UPDATE operator_bookings
     SET payment_status = 'pending', updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND paid_at IS NULL
       AND payment_status IS DISTINCT FROM 'paid'`,
    [bookingId.toString()],
  );
}
