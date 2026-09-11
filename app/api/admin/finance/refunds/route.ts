/**
 * POST /api/admin/finance/refunds — отметить возврат туристу сделанным
 *
 * ── Что это, и чего это НЕ делает ──────────────────────────────────────────
 *
 * Решение владельца 11.09 (#1813): возврат за отменённую оплаченную бронь —
 * 100%, без исключений по срокам. Платёжного API для возврата (CloudPayments,
 * СБП Точка) платформа не вызывает — интеграция не подключена, это отдельное
 * решение. Значит деньги переводит администратор ВНЕ платформы (обратным
 * переводом, через личный кабинет платёжной системы — как именно, здесь не
 * определяется), а этот роут ФИКСИРУЕТ факт: кто, когда, сколько и почему.
 *
 * Это не техническая деталь, а разница по существу: писать `REFUNDED` без
 * подтверждения было бы отчётом о переводе, которого не было, — обратный
 * случай автовыплаты оператору за отменённый тур (#1813, первая находка),
 * только с другой стороны. `reason` обязателен и должен называть
 * подтверждение (номер перевода, скриншот, что угодно проверяемое) — не
 * потому что закон требует, а потому что «отметил и забыл» здесь стоит денег.
 *
 * ── Два предохранителя ─────────────────────────────────────────────────────
 *
 * 1. Платёж обязан быть `HELD` и принадлежать ОТМЕНЁННОЙ брони
 *    (`cancelledBookingSql`) — тот же предикат, что не пускает `payouts`
 *    заплатить оператору за неё. Платёж чужой брони или уже выплаченный —
 *    отказ, а не молчаливый пропуск.
 * 2. `FOR UPDATE` внутри транзакции — тот же приём, что у `payouts` (#1217):
 *    два одновременных запроса на один платёж не пометят его возврат дважды.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { transaction } from '@/lib/database';
import { z } from 'zod';
import { cancelledBookingSql, CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';

export const dynamic = 'force-dynamic';

const MarkRefundedSchema = z.object({
  paymentIds: z.array(z.string().uuid()).min(1, 'Выберите хотя бы один платёж'),
  // Не «на всякий случай текст» — подтверждение перевода. Нижняя граница
  // отсекает пустые/формальные строки вроде «ок», не отсекая короткое, но
  // содержательное «квитанция №4412».
  reason: z.string().trim().min(8, 'Опишите подтверждение перевода (номер, скриншот, что угодно проверяемое)').max(500),
});

export async function POST(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;
  const adminId = authOrResponse.userId;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });

  const parsed = MarkRefundedSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Ошибка валидации', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { paymentIds, reason } = parsed.data;

  let rejection: { status: number; error: string } | null = null;

  const result = await transaction(async (client) => {
    const found = await client.query<{ id: string; retail_amount: string }>(
      `SELECT tp.id, tp.retail_amount
         FROM tour_payments tp
        WHERE tp.id = ANY($1::uuid[])
          AND tp.status = 'HELD'
          AND ${cancelledBookingSql('tp', 2)}
        FOR UPDATE`,
      [paymentIds, CANCELLED_STATUS_PARAM],
    );

    if (found.rows.length === 0) {
      rejection = { status: 400, error: 'Нет платежей, готовых к отметке возврата' };
      return null;
    }

    // Как в /api/admin/finance/payouts (#1217): нашлись не все запрошенные —
    // не повод отметить возврат части и промолчать про остальное.
    if (found.rows.length !== paymentIds.length) {
      const foundIds = new Set(found.rows.map((r) => r.id));
      const missing = paymentIds.filter((id) => !foundIds.has(id));
      rejection = {
        status: 409,
        error: `Часть платежей недоступна к отметке (${missing.length} из ${paymentIds.length}): `
          + 'уже отмечены, выплачены оператору или бронь не отменена. Обновите список и повторите.',
      };
      return null;
    }

    const confirmedIds = found.rows.map((r) => r.id);
    const totalRefunded = found.rows.reduce((sum, r) => sum + parseFloat(r.retail_amount), 0);

    await client.query(
      `UPDATE tour_payments
          SET status = 'REFUNDED',
              refunded_at = NOW(),
              refund_amount = retail_amount,
              refund_reason = $2,
              refunded_by = $3,
              updated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [confirmedIds, reason, adminId],
    );

    return { paymentCount: confirmedIds.length, totalRefunded };
  });

  if (rejection !== null) {
    const r = rejection as { status: number; error: string };
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (result === null) {
    return NextResponse.json({ error: 'Не удалось отметить возврат' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: {
      paymentCount: result.paymentCount,
      totalRefunded: Math.round(result.totalRefunded * 100) / 100,
    },
  });
}
