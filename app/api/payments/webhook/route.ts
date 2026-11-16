import { NextRequest, NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { query, transaction } from '@/lib/database';
import { processCloudPaymentsWebhook, CloudPaymentsWebhook } from '@/lib/payments/cloudpayments-webhook';
import { emailService } from '@/lib/notifications/email-service';
import { escapeHtml } from '@/lib/text/escape-html';
import { addBookingContribution } from '@/lib/compute-fund';
import { recordCommissionFromBooking } from '@/lib/payments/commission';
import { holdTourPayment, RELEASE_AFTER_SQL } from '@/lib/payments/hold-tour-payment';
import { canOfferPayment } from '@/lib/bookings/success-view';
import { reportPaidUnconfirmed } from '@/lib/payments/paid-unconfirmed-alert';
import { reportPaymentAnomaly } from '@/lib/payments/payment-anomaly-alert';

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

  // Номер брони (страница /booking-success платит invoiceId = id брони) —
  // целое; tour_payments.id — UUID. Сравнивать строку не того вида с
  // колонкой — это 22P02 и петля повторов.
  const invoice = String(paymentId);
  if (/^\d+$/.test(invoice)) {
    await handleHubBookingPayment(invoice, transactionId.toString(), webhook);
    return;
  }
  if (UUID_RE.test(invoice) && await handleTourPaymentSuccess(invoice, transactionId.toString(), webhook)) {
    return;
  }

  // Номер счёта не нашёлся ни в бронях, ни в платежах туров. Здесь стоял путь
  // через таблицу `payments` (жильё, трансферы), а её на проде нет (baseline
  // 15.08): каждая такая оплата отвечала 500, и CloudPayments повторял её
  // сутки. Деньги при этом у банка — молчать нельзя: тревога человеку, банку —
  // «принято», повтор ничего не изменит (#3433 п. 2).
  await reportPaymentAnomaly('payments/webhook', { kind: 'unmatched', provider: 'CloudPayments', paid: webhook.Amount });
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
    const locked = await client.query<{
      booking_id: string; status: string; retail_amount: string; cp_transaction_id: string | null;
    }>(
      `SELECT booking_id::text AS booking_id, status, retail_amount, cp_transaction_id
         FROM tour_payments WHERE id = $1 FOR UPDATE`,
      [invoiceId],
    );
    const tp = locked.rows[0];
    if (!tp) return { kind: 'not_found' as const };
    if (tp.status !== 'PENDING' && tp.status !== 'FAILED') {
      // Повтор того же уведомления — no-op. Другая операция по уже оплаченному
      // счёту — деньги взяты дважды (#3433 п. 2).
      return tp.cp_transaction_id === transactionId
        ? { kind: 'duplicate' as const, bookingId: tp.booking_id }
        : { kind: 'second_payment' as const, bookingId: tp.booking_id, expected: Number(tp.retail_amount) };
    }
    if (!amountMatches(tp.retail_amount, webhook.Amount)) {
      return { kind: 'mismatch' as const, bookingId: tp.booking_id, expected: Number(tp.retail_amount) };
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
    const before = await markBookingPaid(client, tp.booking_id, invoiceId);
    // Комиссия — в той же транзакции, что оплата (#3433 п. 2): после коммита
    // её терял упавший процесс, а повтор уведомления видел «уже оплачено».
    // С неподтверждённой брони комиссия не берётся — решает человек.
    if (canOfferPayment(before)) await recordCommissionFromBooking(tp.booking_id, invoiceId, client);
    return { kind: 'held' as const, bookingId: tp.booking_id, before };
  });

  if (outcome.kind === 'not_found') return false;
  if (outcome.kind === 'mismatch' || outcome.kind === 'second_payment') {
    await reportPaymentAnomaly('payments/webhook', {
      kind: outcome.kind === 'mismatch' ? 'amount_mismatch' : 'second_payment',
      provider: 'CloudPayments', bookingId: outcome.bookingId, expected: outcome.expected, paid: webhook.Amount,
    });
    return true;
  }
  if (outcome.kind === 'held' && !canOfferPayment(outcome.before)) {
    await reportPaidUnconfirmed('payments/webhook', outcome.bookingId, outcome.before, webhook.Amount);
    return true;
  }
  if (outcome.kind === 'held') {
    void addBookingContribution('booking_operator', outcome.bookingId, webhook.Amount, 'operator booking confirmed');
  }
  return true;
}

/**
 * Отметить бронь оплаченной и вернуть статус, который был ДО оплаты.
 *
 * Статус меняется только у брони, которую можно было платить
 * (`confirmed`/`pending_payment`, lib/bookings/success-view). Остальные
 * сохраняют свой: отменённую не воскрешаем, а НЕПОДТВЕРЖДЁННУЮ (`new`) оплата
 * не подтверждает — до 04.10 здесь стояло «всё, кроме отменённых, —
 * confirmed», и деньги за заявку подменяли согласие оператора. Деньги при этом
 * записаны всегда (payment_status, paid_at): банк их уже взял, и решать —
 * подтвердить или вернуть — человеку (reportPaidUnconfirmed). Обычно до этого
 * не доходит: Check (/api/payments/check) отклоняет такой платёж до списания.
 */
async function markBookingPaid(client: Pick<PoolClient, 'query'>, bookingId: string, paymentId: string): Promise<string | null> {
  const prev = await client.query<{ booking_status: string | null }>(
    `SELECT booking_status FROM operator_bookings WHERE id = $1::bigint FOR UPDATE`,
    [bookingId],
  );
  await client.query(
    `UPDATE operator_bookings
        SET payment_status = 'paid',
            payment_id = $1,
            paid_at = COALESCE(paid_at, NOW()),
            booking_status = CASE WHEN booking_status IN ('confirmed', 'pending_payment')
                                  THEN 'confirmed' ELSE booking_status END,
            updated_at = NOW()
      WHERE id = $2::bigint`,
    [paymentId, bookingId],
  );
  return prev.rows[0]?.booking_status ?? null;
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
      id: string; final_price: string; payment_status: string | null; payment_id: string | null;
      paid_at: Date | null; tourist_email: string | null; tourist_name: string;
    }>(
      `SELECT id::text AS id, final_price, payment_status, payment_id, paid_at, tourist_email, tourist_name
         FROM operator_bookings
        WHERE id = $1::bigint AND deleted_at IS NULL
        FOR UPDATE`,
      [invoiceId],
    );
    const b = locked.rows[0];
    if (!b) return { kind: 'unmatched' as const };
    if (b.payment_status === 'paid' || b.paid_at) {
      // Повтор того же уведомления — no-op. Другая операция (вторая попытка
      // картой, карта после QR) — деньги взяты дважды (#3433 п. 2).
      return b.payment_id === transactionId
        ? { kind: 'duplicate' as const }
        : { kind: 'second_payment' as const, bookingId: b.id, expected: Number(b.final_price) };
    }
    if (!amountMatches(b.final_price, webhook.Amount)) {
      return { kind: 'amount_mismatch' as const, bookingId: b.id, expected: Number(b.final_price) };
    }
    const before = await markBookingPaid(client, b.id, transactionId);
    await holdTourPayment(client, b.id, {
      transactionId,
      invoiceId,
      method: webhook.CardType ?? 'card',
    });
    // Комиссия — в той же транзакции, что оплата (#3433 п. 2).
    if (canOfferPayment(before)) await recordCommissionFromBooking(b.id, invoiceId, client);
    return { kind: 'paid' as const, ...b, before };
  });

  if (outcome.kind === 'duplicate') return;
  if (outcome.kind === 'unmatched') {
    await reportPaymentAnomaly('payments/webhook', { kind: 'unmatched', provider: 'CloudPayments', paid: webhook.Amount });
    return;
  }
  if (outcome.kind !== 'paid') {
    await reportPaymentAnomaly('payments/webhook', {
      kind: outcome.kind, provider: 'CloudPayments', bookingId: outcome.bookingId, expected: outcome.expected, paid: webhook.Amount,
    });
    return;
  }
  const b = outcome;
  if (!canOfferPayment(b.before)) {
    await reportPaidUnconfirmed('payments/webhook', b.id, b.before, webhook.Amount);
    return;
  }

  void addBookingContribution('booking_operator', b.id, webhook.Amount, 'hub booking confirmed');

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
 * Отказ или отмена платежа (#3433 п. 2). Раньше шли в таблицу `payments`,
 * которой на проде нет: каждый отказ по карте отвечал 500, и CloudPayments
 * повторял его сутки. Теперь — по броне или платежу тура, и только пока оплаты
 * нет: отказ повторной попытки не трогает оплаченную бронь, а статус брони
 * отказ не меняет вовсе — турист может заплатить ещё раз. Отказ или отмена по
 * уже оплаченной брони — тревога человеку: не вернули ли деньги.
 */
async function handleFailedPayment(webhook: CloudPaymentsWebhook) {
  const invoice = String(webhook.InvoiceId);
  if (/^\d+$/.test(invoice)) {
    const res = await query<{ paid: boolean }>(
      `WITH b AS (
         SELECT id, (paid_at IS NOT NULL OR payment_status = 'paid') AS paid
           FROM operator_bookings WHERE id = $1::bigint AND deleted_at IS NULL
       ), upd AS (
         UPDATE operator_bookings ob SET payment_status = 'failed', updated_at = NOW()
           FROM b WHERE ob.id = b.id AND NOT b.paid
       )
       SELECT paid FROM b`,
      [invoice],
    );
    if (res.rows[0]?.paid && webhook.Status === 'Cancelled') {
      await reportPaymentAnomaly('payments/webhook', {
        kind: 'refused_after_paid', provider: 'CloudPayments', bookingId: invoice, paid: webhook.Amount,
      });
    }
    return;
  }
  if (UUID_RE.test(invoice)) {
    await query(
      `UPDATE tour_payments SET status = 'FAILED', updated_at = NOW() WHERE id = $1::uuid AND status = 'PENDING'`,
      [invoice],
    );
    return;
  }
  console.error('[payments/webhook] отказ по счёту, которого нет ни в бронях, ни в платежах туров — не записан');
}

/**
 * Платёж в ожидании — только пока оплаты нет: поздний Pending не переписывает
 * «оплачено» (порядок уведомлений банк не гарантирует).
 */
async function handlePendingPayment(webhook: CloudPaymentsWebhook) {
  const invoice = String(webhook.InvoiceId);
  if (!/^\d+$/.test(invoice)) return;
  await query(
    `UPDATE operator_bookings SET payment_status = 'pending', updated_at = NOW()
      WHERE id = $1::bigint AND deleted_at IS NULL AND paid_at IS NULL
        AND payment_status IS DISTINCT FROM 'paid'`,
    [invoice],
  );
}
