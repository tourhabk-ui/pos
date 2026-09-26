/**
 * GET /api/agent/dashboard — обзор агента: метрики за период и ближайшие брони.
 *
 * ── Что было (разбор 26.09) ────────────────────────────────────────────────
 * Обзор считался по agent_bookings — отдельной таблице броней «за клиента»,
 * которую оператор не видел и в которую с 26.09 не пишет никто (бронь агента
 * теперь обычная бронь оператора с agent_user_id, миграция 1022). Комиссия
 * бралась из agent_bookings.agent_commission (зашитые 10%), в выручку шли
 * неоплаченные и отменённые. А `JSON.parse` над jsonb-колонкой tags ронял
 * весь обзор у ЛЮБОГО агента, у которого был хоть один клиент: драйвер
 * отдаёт jsonb уже разобранным массивом, и parse получал не строку.
 * Каталог «недавних клиентов», графики и «ожидающие выплаты» из этого роута
 * не читал ни один экран.
 *
 * ── Что теперь ─────────────────────────────────────────────────────────────
 * Продажи — брони оператора с agent_user_id = агент. Выручка — только
 * оплаченные и не отменённые. Вознаграждение — только из единственной функции
 * денег агента (lib/payments/agent-commission.ts); ставка не назначена —
 * суммы null, а не 0. Отказ базы — 503 с SQLSTATE в логе, а не «0 ₽».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgent } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';
import { DASHBOARD_SQL } from '@/lib/agent-cabinet/queries';
import {
  loadAgentMoney, commissionAmount, logAgentMoneyFailure, sqlstateOf,
} from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  period: z.enum(['7', '30', '90', '365']).default('30'),
});


interface MetricsRow {
  total_clients: number;
  active_clients: number;
  total_bookings: number;
  cancelled_bookings: number;
  completed_bookings: number;
  unpaid_bookings: number;
  paid_revenue: string;
  paid_bookings: number;
}

interface UpcomingRow {
  id: string;
  client_name: string | null;
  tour_name: string;
  tour_date: string;
  total_price: string | null;
  paid: boolean;
}

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  const parsed = QuerySchema.safeParse({ period: new URL(request.url).searchParams.get('period') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректный период' }, { status: 400 });
  }
  const period = Number(parsed.data.period);

  try {
    const [metricsRes, upcomingRes, money] = await Promise.all([
      pool.query<MetricsRow>(DASHBOARD_SQL.metrics, [auth.userId, period, CANCELLED_STATUS_PARAM]),
      pool.query<UpcomingRow>(DASHBOARD_SQL.upcoming, [auth.userId, CANCELLED_STATUS_PARAM]),
      loadAgentMoney(pool, auth.userId),
    ]);
    const m = metricsRes.rows[0];
    const revenue = Number(m?.paid_revenue ?? 0);
    const paidBookings = m?.paid_bookings ?? 0;
    const s = money.summary;

    return NextResponse.json({
      success: true,
      data: {
        metrics: {
          totalClients: m?.total_clients ?? 0,
          activeClients: m?.active_clients ?? 0,
          totalBookings: m?.total_bookings ?? 0,
          unpaidBookings: m?.unpaid_bookings ?? 0,
          completedBookings: m?.completed_bookings ?? 0,
          cancelledBookings: m?.cancelled_bookings ?? 0,
          paidBookings,
          paidRevenue: revenue,
          // Средний чек по оплаченным; оплаченных нет — не «0 ₽», а нет числа.
          averageBookingValue: paidBookings > 0 ? Math.round(revenue / paidBookings) : null,
        },
        // Вознаграждение — за всё время, из единственной функции денег агента.
        commission: {
          rate: s.rate,
          waiting: s.waiting,
          payable: s.payable,
          requested: s.requested,
          paidOut: s.paidOut,
          flagged: s.flagged,
        },
        upcomingBookings: upcomingRes.rows.map((r) => {
          const price = r.total_price === null ? null : Number(r.total_price);
          return {
            id: r.id,
            clientName: r.client_name,
            tourName: r.tour_name,
            tourDate: r.tour_date,
            totalPrice: price,
            // Вознаграждение начисляется с оплаченной брони; до оплаты — нет числа.
            commission: r.paid ? commissionAmount(price, money.rate) : null,
          };
        }),
      },
    });
  } catch (err) {
    logAgentMoneyFailure('GET /api/agent/dashboard', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить обзор', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
