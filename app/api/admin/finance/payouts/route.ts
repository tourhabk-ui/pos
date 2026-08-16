/**
 * GET  /api/admin/finance/payouts — список tour_payments + operator_payouts + статистика
 * POST /api/admin/finance/payouts — создать выплату оператору вручную (batch HELD → RELEASED)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query, transaction } from '@/lib/database';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const CreatePayoutSchema = z.object({
  operatorId: z.string().uuid('Некорректный ID оператора'),
  paymentIds: z.array(z.string().uuid()).min(1, 'Выберите хотя бы один платёж'),
  periodStart: z.string().date(),
  periodEnd:   z.string().date(),
  reference:   z.string().max(255).optional(),
});

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const sp = request.nextUrl.searchParams;
  const statusFilter    = sp.get('status') || 'all';
  const operatorFilter  = sp.get('operator_id');

  // Глобальная статистика
  const statsResult = await query(
    `SELECT
       COALESCE(SUM(retail_amount), 0)                                    AS total_retail,
       COALESCE(SUM(net_amount),    0)                                    AS total_net,
       COALESCE(SUM(commission_amount), 0)                                AS total_commission,
       COALESCE(SUM(net_amount) FILTER (WHERE status = 'HELD'),    0)    AS held_net,
       COALESCE(SUM(net_amount) FILTER (WHERE status = 'RELEASED'), 0)   AS released_net,
       COUNT(*) FILTER (WHERE status = 'HELD')                            AS held_count,
       COUNT(*) FILTER (WHERE status = 'RELEASED')                        AS released_count,
       COUNT(*) FILTER (WHERE status = 'REFUNDED')                        AS refunded_count
     FROM tour_payments`
  );

  // tour_payments с фильтрами
  const conditions: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (statusFilter !== 'all') {
    conditions.push(`tp.status = $${idx++}`);
    vals.push(statusFilter.toUpperCase());
  }
  if (operatorFilter) {
    conditions.push(`tp.operator_id = $${idx++}`);
    vals.push(operatorFilter);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  vals.push(100);
  const paymentsResult = await query(
    `SELECT
       tp.id, tp.operator_id, tp.retail_amount, tp.net_amount,
       tp.commission_amount, tp.commission_rate, tp.status,
       tp.paid_at, tp.release_after, tp.released_at, tp.refunded_at,
       tp.cp_transaction_id,
       p.company_name AS operator_name,
       ot.title       AS tour_title,
       ob.booking_date, ob.participants, ob.tourist_name
     FROM tour_payments tp
     JOIN partners p ON p.id = tp.operator_id
     JOIN operator_bookings ob ON ob.id = tp.booking_id
     JOIN operator_tours ot ON ot.id = ob.operator_tour_id
     ${where}
     ORDER BY tp.paid_at DESC
     LIMIT $${idx}`,
    vals
  );

  // operator_payouts история
  const payoutsResult = await query(
    `SELECT op.*, p.company_name AS operator_name
     FROM operator_payouts op
     JOIN partners p ON p.id = op.operator_id
     ORDER BY op.created_at DESC
     LIMIT 50`
  );

  // HELD платежи готовые к выплате (release_after < NOW)
  const readyResult = await query(
    `SELECT tp.operator_id, p.company_name AS operator_name,
            COUNT(*) AS count,
            SUM(tp.net_amount) AS total_net
     FROM tour_payments tp
     JOIN partners p ON p.id = tp.operator_id
     WHERE tp.status = 'HELD' AND tp.release_after < NOW()
     GROUP BY tp.operator_id, p.company_name
     ORDER BY total_net DESC`
  );

  const s = statsResult.rows[0];

  return NextResponse.json({
    success: true,
    data: {
      stats: {
        totalRetail:     parseFloat(s.total_retail     as string),
        totalNet:        parseFloat(s.total_net        as string),
        totalCommission: parseFloat(s.total_commission as string),
        heldNet:         parseFloat(s.held_net         as string),
        releasedNet:     parseFloat(s.released_net     as string),
        heldCount:       parseInt(s.held_count      as string, 10),
        releasedCount:   parseInt(s.released_count  as string, 10),
        refundedCount:   parseInt(s.refunded_count  as string, 10),
      },
      payments:     paymentsResult.rows,
      payouts:      payoutsResult.rows,
      readyForPayout: readyResult.rows,
    },
  });
}

export async function POST(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;
  const adminId = authOrResponse.userId;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });

  const parsed = CreatePayoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Ошибка валидации', details: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const { operatorId, paymentIds, periodStart, periodEnd, reference } = parsed.data;

  /**
   * Выплата целиком в ОДНОЙ транзакции с блокировкой платежей (#1217).
   *
   * Было: SELECT без блокировки → INSERT выплаты → UPDATE платежей →
   * пересчёт комиссии, четырьмя отдельными запросами. Два способа отдать
   * деньги дважды:
   *
   *   1. Сбой между INSERT и UPDATE — выплата создана, платежи остались
   *      HELD. Админ видит «выплаты по ним нет» и запускает снова.
   *   2. Два одновременных запроса — оба читают одни и те же HELD-платежи
   *      (SELECT без FOR UPDATE ничего не блокирует) и оба создают выплату.
   *      Уникальный индекс тут не спасает: payment_ids — массив.
   *
   * Теперь строки блокируются FOR UPDATE до любых изменений. Второй
   * одновременный запрос ждёт коммита первого, после чего условие
   * status = 'HELD' ему уже не подходит — он честно получает отказ.
   */
  let rejection: { status: number; error: string } | null = null;

  const result = await transaction(async client => {
    const paymentsResult = await client.query(
      `SELECT id, net_amount FROM tour_payments
       WHERE id = ANY($1::uuid[])
         AND operator_id = $2
         AND status = 'HELD'
       FOR UPDATE`,
      [paymentIds, operatorId]
    );

    if (paymentsResult.rows.length === 0) {
      rejection = { status: 400, error: 'Нет платежей готовых к выплате' };
      return null;
    }

    /**
     * Нашлись не все запрошенные платежи — это не повод молча заплатить
     * за часть. Админ выбрал десять, получил бы выплату по трём и не узнал
     * бы об этом: остальные семь уже кем-то выплачены, отменены или
     * принадлежат другому оператору. Разница между «выплатил» и «выплатил
     * частично» в деньгах слишком велика, чтобы решать её за человека.
     */
    if (paymentsResult.rows.length !== paymentIds.length) {
      const found = new Set(paymentsResult.rows.map(r => r.id as string));
      const missing = paymentIds.filter(id => !found.has(id));
      rejection = {
        status: 409,
        error: `Часть платежей недоступна к выплате (${missing.length} из ${paymentIds.length}): `
          + 'они уже выплачены, отменены или принадлежат другому оператору. '
          + 'Обновите список и повторите.',
      };
      return null;
    }

    const totalNet = paymentsResult.rows.reduce(
      (sum, r) => sum + parseFloat(r.net_amount as string), 0
    );
    const confirmedIds = paymentsResult.rows.map(r => r.id as string);

    // Реквизиты оператора — в той же транзакции: они попадают в запись
    // выплаты, и читать их отдельным соединением незачем.
    const partnerResult = await client.query(
      `SELECT payout_method, payout_details, payout_verified FROM partners WHERE id = $1`,
      [operatorId]
    );
    const partner = partnerResult.rows[0];

    const payoutResult = await client.query(
      `INSERT INTO operator_payouts (
         operator_id, total_net, booking_count, payment_ids,
         payout_method, payout_details,
         status, period_start, period_end, payment_reference, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10)
       RETURNING id`,
      [
        operatorId,
        totalNet,
        confirmedIds.length,
        confirmedIds,
        partner?.payout_method ?? null,
        partner?.payout_details ?? null,
        periodStart,
        periodEnd,
        reference ?? null,
        adminId,
      ]
    );

    await client.query(
      `UPDATE tour_payments
       SET status = 'RELEASED', released_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [confirmedIds]
    );

    // Пересчёт комиссии тоже внутри: иначе при откате выплаты он остался бы
    // посчитанным по платежам, которые так и не выплачены.
    await client.query(`SELECT recalculate_commission($1)`, [operatorId]);

    return {
      payoutId: payoutResult.rows[0].id as string,
      totalNet,
      paymentCount: confirmedIds.length,
      payoutVerified: Boolean(partner?.payout_verified),
    };
  });

  // Отказ по существу — не ошибка сервера: транзакция откатилась, ничего
  // не записано, человеку нужен понятный текст, а не 500.
  if (rejection !== null) {
    const r = rejection as { status: number; error: string };
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (result === null) {
    return NextResponse.json({ error: 'Не удалось создать выплату' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: {
      payoutId: result.payoutId,
      totalNet: Math.round(result.totalNet * 100) / 100,
      paymentCount: result.paymentCount,
      status: 'PENDING',
      note: result.payoutVerified
        ? 'Реквизиты подтверждены — готово к отправке через CP Payouts'
        : 'Реквизиты оператора не верифицированы — выплата ручная',
    },
  });
}
