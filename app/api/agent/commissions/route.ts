/**
 * GET /api/agent/commissions — вознаграждение агента: ставка, продажи, итоги.
 *
 * Всё считает единственная функция денег агента
 * (lib/payments/agent-commission.ts): продажи — брони оператора с
 * agent_user_id = агент; начисляется только с оплаченной и не отменённой;
 * к выплате — после конца тура + 36 ч. Ставку назначает владелец; пока её
 * нет, суммы приходят null («ставка не назначена»), а не нулём.
 *
 * Прежде роут отдавал строки agent_commissions — их писал только старый
 * POST брони агента с зашитыми 10% и ссылкой на agent_bookings. Такие строки
 * деньгами не являются и здесь больше не читаются.
 *
 * Смотреть свои деньги может и неодобренный агент; запросить выплату — нет
 * (request-payout, requireApprovedAgent).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAgent } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { AGENT_MONEY_SQL, loadAgentMoney, logAgentMoneyFailure, sqlstateOf } from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  state: z.enum(['all', 'cancelled', 'unpaid', 'waiting', 'payable', 'requested', 'paid_out']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    state: sp.get('state') ?? undefined,
    limit: sp.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры запроса' }, { status: 400 });
  }
  const { state, limit } = parsed.data;

  try {
    const money = await loadAgentMoney(pool, auth.userId);
    const payouts = await pool.query(AGENT_MONEY_SQL.agentPayouts, [auth.userId, 20]);
    const sales = (state === 'all' ? money.sales : money.sales.filter((s) => s.state === state)).slice(0, limit);

    return NextResponse.json({
      success: true,
      data: {
        rate: money.rate,
        rateSetAt: money.profile?.rate_set_at ?? null,
        profileStatus: money.profile?.profile_status ?? null,
        summary: money.summary,
        sales,
        payouts: payouts.rows,
      },
    });
  } catch (err) {
    logAgentMoneyFailure('GET /api/agent/commissions', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось получить вознаграждение', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
