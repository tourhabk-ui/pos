/**
 * POST /api/payments/check — Check-уведомление CloudPayments: банк спрашивает
 * ДО списания, принимать ли платёж. Правило — lib/payments/cloudpayments-check.
 *
 * Платится только бронь, подтверждённая оператором, на её сумму и один раз.
 * Ответ не `{ code: 0 }` — CloudPayments отклоняет платёж, деньги туриста не
 * трогаются. Поэтому любой «не смог» (подпись, разбор, база) — отказ, а не
 * пропуск: пропущенный платёж за неподтверждённую бронь потом разбирает
 * человек вручную, отклонённый турист просто повторит после подтверждения.
 *
 * Адрес прописывается в кабинете CloudPayments: «Уведомления» → Check.
 */
// AUTH: публичный приёмник CloudPayments; доступ контролируется HMAC-подписью (CLOUDPAYMENTS_API_SECRET).
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { validateCloudPaymentsSignature } from '@/lib/payments/cloudpayments-webhook';
import { decideCloudPaymentsCheck, parseCheckBody, type CheckBookingRow } from '@/lib/payments/cloudpayments-check';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function answer(code: number) {
  // CloudPayments читает code из тела; HTTP — всегда 200, иначе он повторяет.
  return NextResponse.json({ code });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const secret = process.env.CLOUDPAYMENTS_API_SECRET ?? '';
  if (!validateCloudPaymentsSignature(raw, request.headers.get('X-Content-HMAC'), secret)) {
    console.error('[payments/check] подпись не прошла — платёж отклонён', secret ? '' : '(CLOUDPAYMENTS_API_SECRET не задан)');
    return answer(13);
  }

  const body = parseCheckBody(raw);
  if (!body) {
    console.error('[payments/check] тело не разобрано — платёж отклонён');
    return answer(13);
  }

  let row: CheckBookingRow | null = null;
  try {
    if (/^\d+$/.test(body.invoiceId)) {
      const r = await query<CheckBookingRow>(
        `SELECT booking_status, payment_status, paid_at, final_price, (deleted_at IS NOT NULL) AS deleted
           FROM operator_bookings
          WHERE id = $1::bigint`,
        [body.invoiceId],
      );
      row = r.rows[0] ?? null;
    } else if (UUID_RE.test(body.invoiceId)) {
      // Счёт по строке tour_payments (PENDING): сумма — её, статус — брони.
      const r = await query<CheckBookingRow>(
        `SELECT ob.booking_status, ob.payment_status, ob.paid_at, tp.retail_amount AS final_price,
                (ob.deleted_at IS NOT NULL) AS deleted
           FROM tour_payments tp
           JOIN operator_bookings ob ON ob.id = tp.booking_id
          WHERE tp.id = $1::uuid`,
        [body.invoiceId],
      );
      row = r.rows[0] ?? null;
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[payments/check] бронь не прочиталась — платёж отклонён:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return answer(13);
  }

  const decision = decideCloudPaymentsCheck(row, body.amount);
  if (decision.code !== 0) {
    console.error('[payments/check] платёж отклонён:', `invoice=${body.invoiceId}`, decision.reason);
  }
  return answer(decision.code);
}
