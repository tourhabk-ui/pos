/**
 * GET /api/agent/commissions/payouts — заявки агента на выплату.
 *
 * Только заявки из продаж (commission_payouts.from_sales, миграция 1024);
 * статусы — ровно те, что пишет код: pending → paid | rejected. Прежний роут
 * принимал любой статус строкой и перечислял несуществующие
 * (processing/completed/failed), а позиции искал в agent_commissions — таблице
 * без оплаченных броней за строками.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgent } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { AGENT_MONEY_SQL, PAYOUT_STATUSES, logAgentMoneyFailure, sqlstateOf } from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['all', ...PAYOUT_STATUSES]).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

interface PayoutRow {
  id: string;
  total_amount: string;
  status: string;
  payment_method: string | null;
  created_at: string;
  paid_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  items: number;
}

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    status: sp.get('status') ?? undefined,
    limit: sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры запроса' }, { status: 400 });
  }
  const { status, limit } = parsed.data;

  try {
    const { rows } = await pool.query<PayoutRow>(AGENT_MONEY_SQL.agentPayouts, [auth.userId, 100]);
    const payouts = (status === 'all' ? rows : rows.filter((r) => r.status === status))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        totalAmount: Number(r.total_amount),
        status: r.status,
        paymentMethod: r.payment_method,
        createdAt: r.created_at,
        paidAt: r.paid_at,
        rejectedAt: r.rejected_at,
        rejectReason: r.reject_reason,
        bookingCount: r.items,
      }));
    return NextResponse.json({ success: true, data: { payouts, total: payouts.length } });
  } catch (err) {
    logAgentMoneyFailure('GET /api/agent/commissions/payouts', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось получить заявки на выплату', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
