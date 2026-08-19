import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAgent } from '@/lib/auth/middleware';
import { z } from 'zod';

const RequestPayoutSchema = z.object({
  paymentMethod: z.string().optional().default('bank_transfer'),
});

export const dynamic = 'force-dynamic';

/**
 * POST /api/agent/commissions/request-payout - Запросить выплату комиссионных
 */
export async function POST(request: NextRequest) {
  try {
    const userOrResponse = await requireAgent(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const agentId = userOrResponse.userId;
    const body = await request.json();
    const parsed = RequestPayoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const { paymentMethod } = parsed.data;

    /**
     * Всё — в одной транзакции, и pending-комиссии берутся под замок.
     *
     * Прежде три запроса шли по отдельности: читаем pending, создаём выплату,
     * переводим комиссии в processing. Между первым и третьим окно, в которое
     * помещается второй такой же запрос — и он прочитает те же строки, ещё не
     * ставшие processing. Итог: две выплаты на одни и те же комиссии, то есть
     * агенту платят дважды. Кнопку «запросить выплату» нажимают дважды
     * буднично: подвисла сеть, показалось, что не сработало.
     *
     * FOR UPDATE держит строки до конца транзакции: второй запрос ждёт, а
     * дождавшись, не увидит их в pending и честно ответит «нечего выплачивать».
     * SKIP LOCKED здесь НЕ годится — он бы дал второму запросу пропустить
     * занятые строки и создать пустую или частичную выплату вместо отказа.
     * (В кроне payouts SKIP LOCKED уместен: там задача разгрести очередь
     * параллельно, а не ответить одному человеку на одно нажатие.)
     */
    const payoutId = `payout-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const result = await transaction(async (client) => {
      const commissionsResult = await client.query<{ id: string; amount: string }>(
        `SELECT id, amount FROM agent_commissions
          WHERE agent_id = $1 AND status = 'pending'
          FOR UPDATE`,
        [agentId],
      );

      if (commissionsResult.rows.length === 0) return null;

      const totalAmount = commissionsResult.rows.reduce((sum, row) => sum + parseFloat(row.amount), 0);
      const commissionIds = commissionsResult.rows.map((row) => row.id);

      const payoutResult = await client.query<{ id: string; created_at: unknown }>(
        `INSERT INTO commission_payouts (
           id, agent_id, total_amount, status, payment_method, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING id, created_at`,
        [payoutId, agentId, totalAmount, 'pending', paymentMethod],
      );

      await client.query(
        `UPDATE agent_commissions
            SET status = 'processing', payout_reference = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[])`,
        [payoutId, commissionIds],
      );

      return { payout: payoutResult.rows[0], totalAmount, commissionCount: commissionIds.length };
    });

    if (result === null) {
      return NextResponse.json(
        { success: false, error: 'Нет ожидающих комиссионных для выплаты' } as ApiResponse<null>,
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        payoutId: result.payout.id,
        totalAmount: result.totalAmount,
        commissionCount: result.commissionCount,
        createdAt: result.payout.created_at,
      },
      message: 'Запрос на выплату комиссионных успешно создан',
    } as ApiResponse<unknown>);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: 'Ошибка при создании запроса на выплату',
      } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
