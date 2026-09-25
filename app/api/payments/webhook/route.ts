import { NextRequest, NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { query, transaction } from '@/lib/database';
import { processCloudPaymentsWebhook, CloudPaymentsWebhook } from '@/lib/payments/cloudpayments-webhook';
import { emailService } from '@/lib/notifications/email-service';
import { escapeHtml } from '@/lib/text/escape-html';
import { PaymentWebhookReturnRow, PaymentRow, EmailRow } from '@/lib/types/db-rows';
import { addBookingContribution } from '@/lib/compute-fund';
import { recordCommissionFromBooking } from '@/lib/payments/commission';
import { holdTourPayment, RELEASE_AFTER_SQL } from '@/lib/payments/hold-tour-payment';

export const dynamic = 'force-dynamic';

/**
 * POST /api/payments/webhook
 * CloudPayments webhook endpoint
 * Обработка уведомлений о платежах
 */
// AUTH: публичный webhook от CloudPayments; доступ контролируется HMAC-подписью в processCloudPaymentsWebhook.
export async function POST(request: NextRequest) {
  try {
    // Получаем сырое тело запроса и подпись
    const body = await request.text();
    const signature = request.headers.get('X-Content-HMAC');

    // Валидация webhook
    const validationResult = await processCloudPaymentsWebhook(body, signature);

    if (!validationResult.success) {
      return NextResponse.json({
        code: 13,
        message: validationResult.error || 'Invalid webhook'
      }, { status: 400 });
    }

    const webhookData = validationResult.data as CloudPaymentsWebhook;

    // Обработка webhook в зависимости от статуса
    switch (webhookData.Status) {
      case 'Completed':
        await handleSuccessfulPayment(webhookData);
        break;
      case 'Declined':
      case 'Cancelled':
        await handleFailedPayment(webhookData);
        break;
      case 'Pending':
        await handlePendingPayment(webhookData);
        break;
      default:
        break;
    }

    // CloudPayments ждёт ответ с code: 0
    return NextResponse.json({ code: 0 });

  } catch (error) {
    // 500 — CloudPayments повторит; повтор идемпотентен. Причина — в лог:
    // раньше отказ уходил без единой строки, и «деньги списаны, бронь не
    // оплачена» разбирать было не по чему.
    const e = error as { code?: string; message?: string };
    console.error('[payments/webhook] отказ обработки:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({
      code: 13,
      message: 'Internal error'
    }, { status: 500 });
  }
}

/**
 * Обработка успешного платежа
 */
async function handleSuccessfulPayment(webhook: CloudPaymentsWebhook) {
  const paymentId = webhook.InvoiceId;
  const transactionId = webhook.TransactionId;

  // Сначала — туры. Раньше первым шёл `UPDATE payments`, а таблицы `payments`
  // в базе прода нет (baseline 15.08): каждая успешная оплата отвечала 500,
  // CloudPayments повторял её сутки, и до туровой ветки дело не доходило.
  // Номер брони (страница /booking-success платит invoiceId = id брони) —
  // целое; tour_payments.id — UUID. Сравнивать строку не того вида с
  // колонкой — это 22P02 и та же петля повторов.
  const invoice = String(paymentId);
  if (/^\d+$/.test(invoice)) {
    await handleHubBookingPayment(invoice, transactionId.toString(), webhook);
    return;
  }
  if (UUID_RE.test(invoice) && await handleTourPaymentSuccess(invoice, transactionId.toString(), webhook)) {
    return;
  }

    // Обновляем статус платежа
    const updatePaymentQuery = `
      UPDATE payments
      SET 
        status = 'completed',
        transaction_id = $1,
        payment_data = $2,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $3
      RETURNING booking_id, booking_type, user_id
    `;

    const paymentResult = await query<PaymentWebhookReturnRow>(updatePaymentQuery, [
      transactionId.toString(),
      JSON.stringify(webhook),
      paymentId
    ]);

    if (paymentResult.rows.length === 0) {
      console.error('[payments/webhook] оплата не сопоставлена ни с одной записью (номер счёта не найден ни в tour_payments, ни в payments)');
      return;
    }

    const payment = paymentResult.rows[0];

    // Обновляем статус бронирования
    let updateBookingQuery = '';
    switch (payment.booking_type) {
      case 'tour':
        updateBookingQuery = `
          UPDATE operator_bookings
          SET payment_status = 'paid', booking_status = 'confirmed', updated_at = NOW()
          WHERE id = $1
        `;
        break;
      case 'accommodation':
        updateBookingQuery = `
          UPDATE accommodation_bookings
          SET payment_status = 'paid', status = 'confirmed', updated_at = NOW()
          WHERE id = $1
        `;
        break;
      case 'transfer':
        updateBookingQuery = `
          UPDATE transfer_bookings
          SET payment_status = 'paid', status = 'confirmed', updated_at = NOW()
          WHERE id = $1
        `;
        break;
    }

    if (updateBookingQuery) {
      await query(updateBookingQuery, [payment.booking_id]);
    }

    // 1% от суммы → фонд AI-вычислений (fire-and-forget, не блокирует платёж)
    void addBookingContribution(
      payment.booking_type === 'transfer' ? 'booking_transfer' : 'booking_tour',
      String(payment.booking_id),
      webhook.Amount,
      `${payment.booking_type} confirmed`,
    );

    // Отправляем email уведомление о подтверждении оплаты
    try {
      // Получаем детали бронирования для email
      let bookingDetails: Record<string, unknown> | null = null;
      let emailSubject = '';
      let emailContent = '';

      switch (payment.booking_type) {
        case 'tour':
          const tourBooking = await query(`
            SELECT b.*, t.title as tour_name, p.name as operator_name
            FROM operator_bookings b
            JOIN operator_tours t ON b.operator_tour_id = t.id
            JOIN partners p ON t.operator_id = p.id
            WHERE b.id = $1
          `, [payment.booking_id]);
          if (tourBooking.rows.length > 0) {
            bookingDetails = tourBooking.rows[0];
            emailSubject = `Оплата подтверждена: ${bookingDetails.tour_name}`;
            emailContent = `
              <h2>Ваша оплата подтверждена!</h2>
              <p><strong>Тур:</strong> ${bookingDetails.tour_name}</p>
              <p><strong>Оператор:</strong> ${bookingDetails.operator_name}</p>
              <p><strong>Дата:</strong> ${bookingDetails.start_date}</p>
              <p><strong>Участники:</strong> ${bookingDetails.guests_count}</p>
              <p><strong>Сумма оплаты:</strong> ${webhook.Amount.toLocaleString('ru-RU')} ₽</p>
              <p><strong>ID транзакции:</strong> ${transactionId}</p>
              <p>Бронирование подтверждено. Детали тура будут отправлены дополнительно.</p>
            `;
          }
          break;

        case 'accommodation':
          const accommodationBooking = await query(`
            SELECT ab.*, a.name as accommodation_name, r.name as room_name
            FROM accommodation_bookings ab
            JOIN accommodation_rooms r ON ab.room_id = r.id
            JOIN accommodations a ON ab.accommodation_id = a.id
            WHERE ab.id = $1
          `, [payment.booking_id]);
          if (accommodationBooking.rows.length > 0) {
            bookingDetails = accommodationBooking.rows[0];
            emailSubject = `Оплата подтверждена: ${bookingDetails.accommodation_name}`;
            emailContent = `
              <h2>Ваша оплата подтверждена!</h2>
              <p><strong>Размещение:</strong> ${bookingDetails.accommodation_name}</p>
              <p><strong>Номер:</strong> ${bookingDetails.room_name}</p>
              <p><strong>Заезд:</strong> ${bookingDetails.check_in_date}</p>
              <p><strong>Выезд:</strong> ${bookingDetails.check_out_date}</p>
              <p><strong>Гости:</strong> ${bookingDetails.adults} взрослых, ${bookingDetails.children} детей</p>
              <p><strong>Сумма оплаты:</strong> ${webhook.Amount.toLocaleString('ru-RU')} ₽</p>
              <p><strong>ID транзакции:</strong> ${transactionId}</p>
              <p>Бронирование подтверждено. Адрес и инструкции по заселению будут отправлены дополнительно.</p>
            `;
          }
          break;

        case 'transfer':
          const transferBooking = await query(`
            SELECT tb.*, ts.from_location, ts.to_location, d.name as driver_name
            FROM transfer_bookings tb
            JOIN transfer_schedules ts ON tb.schedule_id = ts.id
            LEFT JOIN transfer_drivers d ON tb.driver_id = d.id
            WHERE tb.id = $1
          `, [payment.booking_id]);
          if (transferBooking.rows.length > 0) {
            bookingDetails = transferBooking.rows[0];
            emailSubject = `Оплата подтверждена: Трансфер ${transferBooking.rows[0].from_location} → ${transferBooking.rows[0].to_location}`;
            emailContent = `
              <h2>Ваша оплата подтверждена!</h2>
              <p><strong>Маршрут:</strong> ${transferBooking.rows[0].from_location} → ${transferBooking.rows[0].to_location}</p>
              <p><strong>Дата и время:</strong> ${transferBooking.rows[0].departure_time}</p>
              <p><strong>Водитель:</strong> ${transferBooking.rows[0].driver_name || 'Будет назначен'}</p>
              <p><strong>Пассажиры:</strong> ${transferBooking.rows[0].passengers_count}</p>
              <p><strong>Сумма оплаты:</strong> ${webhook.Amount.toLocaleString('ru-RU')} ₽</p>
              <p><strong>ID транзакции:</strong> ${transactionId}</p>
              <p>Бронирование подтверждено. Детали трансфера будут отправлены за 24 часа.</p>
            `;
          }
          break;
      }

      if (bookingDetails) {
        const userEmailResult = await query<EmailRow>(
          'SELECT email FROM users WHERE id = $1',
          [payment.user_id]
        );
        const userEmail = userEmailResult.rows[0]?.email ?? '';
        if (userEmail) {
          await emailService.sendEmail({
            to: userEmail,
            subject: emailSubject,
            html: emailContent
          });
        }
      }
    } catch {
      // Не прерываем выполнение при ошибке email
    }
}

// В лог — только то, что взято из нашей базы, и числа: сырые строки из тела
// вебхука (номер счёта) туда не пишутся, чтобы переводом строки нельзя было
// подделать соседние записи.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Сумма из вебхука против цены брони: расхождение больше рубля — не оплата. */
function amountMatches(expected: string | number, paid: number): boolean {
  return Math.abs(Number(expected) - paid) <= 1;
}

/**
 * Бронь с сайта (/api/bookings/tour): invoiceId = tour_payments.id, строка
 * заведена заранее в PENDING. Возвращает false, если такой строки нет —
 * тогда вызывающий пробует прежний путь `payments`.
 *
 * Отказы записи больше не глушатся: исключение уходит в 500, CloudPayments
 * повторяет, а повтор идемпотентен (статус платежа читается под блокировкой).
 * Раньше здесь стоял пустой catch с ответом code 0 — деньги списаны, бронь
 * не оплачена, и никто об этом не узнавал.
 */
async function handleTourPaymentSuccess(invoiceId: string, transactionId: string, webhook: CloudPaymentsWebhook): Promise<boolean> {
  const outcome = await transaction(async (client) => {
    const locked = await client.query<{ booking_id: string; status: string; retail_amount: string }>(
      `SELECT booking_id::text AS booking_id, status, retail_amount
         FROM tour_payments WHERE id = $1 FOR UPDATE`,
      [invoiceId],
    );
    const tp = locked.rows[0];
    if (!tp) return { kind: 'not_found' as const };
    if (tp.status !== 'PENDING' && tp.status !== 'FAILED') return { kind: 'duplicate' as const, bookingId: tp.booking_id };
    if (!amountMatches(tp.retail_amount, webhook.Amount)) {
      console.error('[payments/webhook] сумма не совпала с платежом тура — не подтверждаем:',
        `booking=${tp.booking_id}`, `expected=${tp.retail_amount}`, `paid=${Number(webhook.Amount).toFixed(2)}`);
      return { kind: 'mismatch' as const, bookingId: tp.booking_id };
    }

    // Срок выплаты оператору — конец тура + 36 часов, как у всех приёмников
    // (lib/payments/hold-tour-payment). До 25.09 здесь стояло NOW() + 36 часов:
    // оператор получал деньги через полтора дня после оплаты, до самого тура.
    await client.query(
      `UPDATE tour_payments tp
          SET status = 'HELD',
              cp_transaction_id = $1,
              cp_invoice_id = $2,
              cp_payment_method = $3,
              paid_at = NOW(),
              release_after = ${RELEASE_AFTER_SQL},
              updated_at = NOW()
         FROM operator_bookings ob
         JOIN operator_tours ot ON ot.id = ob.operator_tour_id
        WHERE tp.id = $4 AND ob.id = tp.booking_id`,
      [transactionId, invoiceId, webhook.CardType ?? 'card', invoiceId],
    );
    await markBookingPaid(client, tp.booking_id, invoiceId);
    return { kind: 'held' as const, bookingId: tp.booking_id };
  });

  if (outcome.kind === 'not_found') return false;
  if (outcome.kind === 'held') {
    void addBookingContribution('booking_operator', outcome.bookingId, webhook.Amount, 'operator booking confirmed');
    await createCommissionRecord(outcome.bookingId, invoiceId);
  }
  return true;
}

/**
 * Отметить бронь оплаченной. Отменённую не воскрешаем: деньги записаны
 * (payment_status, paid_at), статус остаётся — возврат решает человек
 * (tour_payments в HELD по отменённой брони видит «Ждут возврата»). Раньше
 * отменённая бронь либо молча становилась confirmed, либо не менялась вовсе,
 * и оплата терялась.
 */
async function markBookingPaid(client: Pick<PoolClient, 'query'>, bookingId: string, paymentId: string) {
  await client.query(
    `UPDATE operator_bookings
        SET payment_status = 'paid',
            payment_id = $1,
            paid_at = COALESCE(paid_at, NOW()),
            booking_status = CASE WHEN booking_status IN ('cancelled', 'rejected')
                                  THEN booking_status ELSE 'confirmed' END,
            updated_at = NOW()
      WHERE id = $2::bigint`,
    [paymentId, bookingId],
  );
}

/**
 * Бронь, у которой нет PENDING-строки платежа (страница /booking-success
 * платит invoiceId = id брони). Раньше здесь только помечалась бронь, а
 * `tour_payments` не писался вовсе: оператор не видел оплату в «Финансах»,
 * выплата её не находила, возврат при отмене считал «оплаты не было».
 */
async function handleHubBookingPayment(invoiceId: string, transactionId: string, webhook: CloudPaymentsWebhook) {
  const outcome = await transaction(async (client) => {
    const locked = await client.query<{
      id: string; final_price: string; payment_status: string | null;
      tourist_email: string | null; tourist_name: string;
    }>(
      `SELECT id::text AS id, final_price, payment_status, tourist_email, tourist_name
         FROM operator_bookings
        WHERE id = $1::bigint AND deleted_at IS NULL
        FOR UPDATE`,
      [invoiceId],
    );
    const b = locked.rows[0];
    if (!b) {
      console.error('[payments/webhook] оплата на несуществующую бронь:', `booking=${Number(invoiceId)}`);
      return null;
    }
    if (b.payment_status === 'paid') return null;
    if (!amountMatches(b.final_price, webhook.Amount)) {
      console.error('[payments/webhook] сумма не совпала с бронью — не подтверждаем:',
        `booking=${b.id}`, `expected=${b.final_price}`, `paid=${Number(webhook.Amount).toFixed(2)}`);
      return null;
    }
    await markBookingPaid(client, b.id, transactionId);
    await holdTourPayment(client, b.id, {
      transactionId,
      invoiceId,
      method: webhook.CardType ?? 'card',
    });
    return b;
  });

  if (!outcome) return;
  const b = outcome;

  void addBookingContribution('booking_operator', b.id, webhook.Amount, 'hub booking confirmed');
  await createCommissionRecord(b.id, invoiceId);

  if (b.tourist_email) {
    try {
      await emailService.sendEmail({
        to: b.tourist_email,
        subject: 'Оплата подтверждена — TourHab',
        html: `
          <h2>Оплата подтверждена!</h2>
          <p><strong>Имя:</strong> ${escapeHtml(b.tourist_name)}</p>
          <p><strong>Сумма:</strong> ${webhook.Amount.toLocaleString('ru-RU')} ₽</p>
          <p><strong>ID транзакции:</strong> ${escapeHtml(transactionId)}</p>
          <p>Оператор свяжется с вами для уточнения деталей тура.</p>
          <p>Ваше бронирование: <a href="https://vedarai.ru/hub/tourist/bookings">Мои бронирования</a></p>
        `,
      });
    } catch (err) {
      console.error('[payments/webhook] письмо об оплате не ушло:', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Создаёт запись комиссии платформы при успешной оплате.
 * Idempotent: повторный вызов с тем же invoice_id игнорируется.
 *
 * Вся логика — в `lib/payments/commission`, общей с hub-вебхуком (там комиссия
 * раньше не начислялась вовсе). Раньше здесь считались захардкоженные 12%, из-за
 * чего одна бронь получала разную комиссию в `operator_commissions` и
 * `tour_payments`. Теперь ставка одна и берётся из базы —
 * `partners.commission_current`, приведён к 10% миграцией 811 по решению
 * владельца.
 */
async function createCommissionRecord(
  bookingId: string,
  invoiceId: string,
): Promise<void> {
  await recordCommissionFromBooking(bookingId, invoiceId);
}

/**
 * Обработка неуспешного платежа
 */
async function handleFailedPayment(webhook: CloudPaymentsWebhook) {
  const paymentId = webhook.InvoiceId;

    // Обновляем статус платежа
    const updateQuery = `
      UPDATE payments
      SET 
        status = 'failed',
        transaction_id = $1,
        payment_data = $2,
        failure_reason = $3,
        updated_at = NOW()
      WHERE id = $4
    `;

    await query(updateQuery, [
      webhook.TransactionId.toString(),
      JSON.stringify(webhook),
      webhook.Reason || 'Payment declined',
      paymentId
    ]);

    // Отправляем email о неуспешном платеже
    try {
      // Получаем детали платежа для email.
      //
      // Здесь стояло `SELECT p.*, b.booking_type` с тремя LEFT JOIN на брони
      // тура, жилья и трансфера. Колонки booking_type у operator_bookings нет
      // — она у самого платежа, и `p.*` её уже отдаёт. То есть запрос падал
      // на «column b.booking_type does not exist», и письмо о неудачной оплате
      // не уходило никогда. Джойны при этом ничего не выбирали.
      const paymentDetails = await query<PaymentRow>(`
        SELECT p.*
        FROM payments p
        WHERE p.id = $1
      `, [paymentId]);

      if (paymentDetails.rows.length > 0) {
        const payment = paymentDetails.rows[0];
        const failureReason = webhook.Reason || 'Платёж был отклонён';

        const userEmailResult = await query<EmailRow>(
          'SELECT email FROM users WHERE id = $1',
          [payment.user_id]
        );
        const userEmail = userEmailResult.rows[0]?.email ?? '';
        if (userEmail) {
          await emailService.sendEmail({
            to: userEmail,
            subject: `Платёж не прошёл - ID ${paymentId.substring(0, 8)}`,
            html: `
              <h2>К сожалению, платёж не прошёл</h2>
              <p><strong>ID платежа:</strong> ${paymentId}</p>
              <p><strong>Сумма:</strong> ${parseFloat(payment.amount).toLocaleString('ru-RU')} ₽</p>
              <p><strong>Причина:</strong> ${failureReason}</p>
              <p>Попробуйте оплатить снова или свяжитесь с поддержкой.</p>
              <p><strong>Служба поддержки:</strong> support@kamhub.ru</p>
            `
          });
        }
      }
    } catch {
      // Не прерываем выполнение при ошибке email
    }
}

/**
 * Обработка платежа в ожидании
 */
async function handlePendingPayment(webhook: CloudPaymentsWebhook) {
  const paymentId = webhook.InvoiceId;

    // Обновляем статус
    const updateQuery = `
      UPDATE payments
      SET 
        status = 'processing',
        transaction_id = $1,
        payment_data = $2,
        updated_at = NOW()
      WHERE id = $3
    `;

    await query(updateQuery, [
      webhook.TransactionId.toString(),
      JSON.stringify(webhook),
      paymentId
    ]);
}
