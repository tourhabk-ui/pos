import { NextRequest, NextResponse } from 'next/server';
import { pendingCompensation } from '@/lib/eco/compensation';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import {
  FinanceMetricsRow, DailyFinanceRow, RevenueByTypeRow,
  PendingPayoutsRow, RecentTransactionRow, PayoutAdminRow, PayoutStatsRow,
} from '@/lib/types/db-rows';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PayoutSchema = z.object({
  partnerId: z.string().min(1).max(100),
  bookingId: z.union([z.string().min(1).max(100), z.number().int().positive()]),
  amount: z.number().positive().finite(),
  currency: z.string().length(3).optional(),
  description: z.string().max(500).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { searchParams } = new URL(request.url);
    const tab = searchParams.get('tab') || 'overview';
    // Селектор периода в UI (7/30/90/365) раньше игнорировался — метрики шли
    // за всё время, график всегда за 30 дней. Только допустимые значения.
    const periodRaw = searchParams.get('period') ?? '30';
    const periodDays = ['7', '30', '90', '365'].includes(periodRaw) ? parseInt(periodRaw, 10) : 30;

    if (tab === 'payouts') {
      // Живой контур выплат — operator_payouts (батчи по tour_payments),
      // а не legacy-таблица payouts, которой в БД нет. У батча нет одной
      // брони/услуги: booking_id и service_name честно NULL, сумма — total_net.
      // Статусы живого контура: PENDING/PROCESSING/PAID/FAILED, поэтому
      // «completed» старой схемы — это PAID, «pending» — PENDING.
      const [payoutsResult, statsResult] = await Promise.all([
        query<PayoutAdminRow>(`
          SELECT
            op.id,
            op.operator_id as partner_id,
            COALESCE(p.company_name, p.name) as partner_name,
            p.contact->>'email' as partner_email,
            NULL::bigint as booking_id,
            'tour' as booking_type,
            NULL::text as service_name,
            op.total_net as amount,
            op.currency,
            op.status,
            op.created_at,
            op.paid_at as completed_at,
            op.failure_reason
          FROM operator_payouts op
          JOIN partners p ON op.operator_id = p.id
          ORDER BY op.created_at DESC
          LIMIT 50
        `),
        query<PayoutStatsRow>(`
          SELECT
            COUNT(*)::text as total_payouts,
            COUNT(*) FILTER (WHERE status = 'PAID')::text as completed_payouts,
            COUNT(*) FILTER (WHERE status = 'PENDING')::text as pending_payouts,
            COALESCE(SUM(total_net) FILTER (WHERE status = 'PAID'), 0)::text as total_paid,
            COALESCE(SUM(total_net) FILTER (WHERE status = 'PENDING'), 0)::text as pending_amount
          FROM operator_payouts
        `),
      ]);

      return NextResponse.json({
        success: true,
        data: {
          payouts: payoutsResult.rows,
          stats: statsResult.rows[0],
        },
      });
    }

    const [metrics, dailyRevenue, revenueByType, pendingPayouts, recentTransactions] =
      await Promise.all([
        // Живой контур денег — tour_payments. Успешная оплата туриста —
        // HELD (деньги удержаны до конца тура) или RELEASED (выплачено
        // оператору); PENDING — ещё не оплаченный счёт, REFUNDED/FAILED —
        // не доход. Сумма туриста — retail_amount, дата дохода — paid_at.
        query<FinanceMetricsRow>(`
          SELECT
            COUNT(*)::text as total_transactions,
            COALESCE(SUM(tp.retail_amount), 0)::text as total_revenue,
            COALESCE(AVG(tp.retail_amount), 0)::text as avg_transaction,
            COUNT(DISTINCT LOWER(TRIM(ob.tourist_email)))::text as unique_customers
          FROM tour_payments tp
          JOIN operator_bookings ob ON ob.id = tp.booking_id
          WHERE tp.status IN ('HELD', 'RELEASED')
            AND COALESCE(tp.paid_at, tp.created_at) >= NOW() - ($1 || ' days')::interval
        `, [periodDays]),
        query<DailyFinanceRow>(`
          SELECT
            DATE(COALESCE(tp.paid_at, tp.created_at)) as date,
            COUNT(*)::text as transactions,
            COALESCE(SUM(tp.retail_amount), 0)::text as revenue
          FROM tour_payments tp
          WHERE tp.status IN ('HELD', 'RELEASED')
            AND COALESCE(tp.paid_at, tp.created_at) >= NOW() - ($1 || ' days')::interval
          GROUP BY DATE(COALESCE(tp.paid_at, tp.created_at))
          ORDER BY date ASC
        `, [periodDays]),
        query<RevenueByTypeRow>(`
          SELECT
            'tour' as booking_type,
            COUNT(*)::text as transactions,
            COALESCE(SUM(retail_amount), 0)::text as revenue
          FROM tour_payments
          WHERE status IN ('HELD', 'RELEASED')
            AND COALESCE(paid_at, created_at) >= NOW() - ($1 || ' days')::interval
          GROUP BY 1
        `, [periodDays]),
        query<PendingPayoutsRow>(`
          SELECT
            COUNT(*)::text as pending_count,
            COALESCE(SUM(total_net), 0)::text as pending_amount
          FROM operator_payouts
          WHERE status = 'PENDING'
        `),
        query<RecentTransactionRow>(`
          SELECT
            tp.id,
            tp.retail_amount as amount,
            tp.currency,
            tp.status,
            COALESCE(tp.paid_at, tp.created_at) as created_at,
            'tour' as booking_type,
            t.title as service_name,
            ob.tourist_name as customer_name
          FROM tour_payments tp
          JOIN operator_bookings ob ON ob.id = tp.booking_id
          LEFT JOIN operator_tours t ON t.id = ob.operator_tour_id
          ORDER BY COALESCE(tp.paid_at, tp.created_at) DESC
          LIMIT 20
        `),
      ]);

    // Долг по эко-скидкам: сколько платформа и операторы должны по
    // нерасчитанным претензиям. `pendingCompensation()` была написана и не
    // звалась ниоткуда — выданные скидки не показывались нигде, то есть
    // считать их было негде (перепись 22.08.2026).
    //
    // Отказ этого запроса не валит весь экран финансов: `null` означает «не
    // смогли посчитать» и так и подписывается — это не то же самое, что ноль.
    let ecoCompensation: Awaited<ReturnType<typeof pendingCompensation>> | null = null;
    try {
      ecoCompensation = await pendingCompensation();
    } catch (err) {
      console.error('[admin/finance] долг по эко-компенсациям не посчитан:',
        err instanceof Error ? err.message : err);
    }

    const metricsRow = metrics.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        // UI (FinanceMetricsGrid/RevenueChart) ждёт camelCase и числа, а SQL
        // отдаёт snake_case-строки — без этого преобразования экран падал
        // уже после ответа API. Snake-ключи сохранены для прежних читателей.
        metrics: {
          ...metricsRow,
          totalTransactions: parseInt(metricsRow.total_transactions, 10) || 0,
          totalRevenue: parseFloat(metricsRow.total_revenue) || 0,
          avgTransaction: parseFloat(metricsRow.avg_transaction) || 0,
          uniqueCustomers: parseInt(metricsRow.unique_customers, 10) || 0,
        },
        dailyRevenue: dailyRevenue.rows.map((row) => ({
          date: row.date,
          transactions: parseInt(row.transactions, 10) || 0,
          revenue: parseFloat(row.revenue) || 0,
        })),
        revenueByType: revenueByType.rows,
        pendingPayouts: pendingPayouts.rows[0],
        recentTransactions: recentTransactions.rows,
        ecoCompensation,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении финансовых данных', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const parsed = PayoutSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Обязательные поля: partnerId, bookingId, amount (amount — положительное число)' }, { status: 400 });
    }
    const { partnerId, bookingId, amount, currency, description } = parsed.data;

    // Честной записи в живой контур из этих полей нет: operator_payouts —
    // батч по payment_ids за период (period_start/period_end NOT NULL), а не
    // выплата по одной брони на произвольную сумму. Выдумывать период и
    // состав батча нельзя — создание выплаты живёт в
    // POST /api/admin/finance/payouts, который двигает tour_payments
    // HELD → RELEASED в одной транзакции. Этот роут только валидирует вход
    // (см. тесты zod-валидации) и честно отвечает, куда идти.
    void partnerId; void bookingId; void amount; void currency; void description;
    return NextResponse.json(
      { success: false, error: 'Создание выплаты перенесено в POST /api/admin/finance/payouts' },
      { status: 410 }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при создании выплаты', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
