/**
 * GET /api/agent/stats — статистика агента: начисления по месяцам тура,
 * удержание клиентов, лучшие туры.
 *
 * Прежде роут суммировал agent_commissions (строки без оплаченной брони
 * оператора за ними), считал брони agent_bookings вместе с неоплаченными и
 * не имел try/catch: отказ базы уходил необработанным, а экран показывал
 * «0K ₽». Теперь продажи — брони оператора с agent_user_id; начисления — из
 * единственной функции денег агента; только оплаченные и не отменённые.
 * Ставки нет — суммы null («ставка не назначена»), клиентов нет — удержание
 * null, а не «0%».
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAgent } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';
import { STATS_SQL } from '@/lib/agent-cabinet/queries';
import {
  loadAgentMoney, logAgentMoneyFailure, sqlstateOf, type SaleState,
} from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

/** Начислено: оплачено и не отменено. */
const EARNED: ReadonlySet<SaleState> = new Set<SaleState>(['waiting', 'payable', 'requested', 'paid_out']);

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [money, retentionRes, topRes] = await Promise.all([
      loadAgentMoney(pool, auth.userId),
      pool.query<{ clients: number; repeat_clients: number }>(STATS_SQL.retention, [auth.userId, CANCELLED_STATUS_PARAM]),
      pool.query<{ name: string; bookings: number }>(STATS_SQL.topTours, [auth.userId, CANCELLED_STATUS_PARAM]),
    ]);

    // Начисления по месяцу ТУРА (booking_date): вознаграждение привязано к
    // поездке, а не к дню, когда нажали «забронировать».
    const byMonth = new Map<string, number>();
    for (const s of money.sales) {
      if (!EARNED.has(s.state) || s.bookingDate === null) continue;
      const month = s.bookingDate.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + (s.amount ?? 0));
    }
    const months = [...byMonth.keys()].sort().slice(-6);

    const clients = retentionRes.rows[0]?.clients ?? 0;
    const repeat = retentionRes.rows[0]?.repeat_clients ?? 0;

    return NextResponse.json({
      success: true,
      data: {
        rate: money.rate,
        commissions: months.map((m) => ({
          month: m,
          amount: money.rate === null ? null : Math.round((byMonth.get(m) ?? 0) * 100) / 100,
        })),
        clients,
        retention: clients > 0 ? Math.round((repeat / clients) * 100) : null,
        repeatClients: repeat,
        topTours: topRes.rows,
      },
    });
  } catch (err) {
    logAgentMoneyFailure('GET /api/agent/stats', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить статистику', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
