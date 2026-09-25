/**
 * POST /api/agent/commissions/request-payout — агент запрашивает выплату.
 *
 * ── Что было ───────────────────────────────────────────────────────────────
 * Прежний обработчик не выполнялся НИ РАЗУ: вставлял текстовый id
 * 'payout-…' в uuid-колонку commission_payouts (22P02), переводил
 * agent_commissions в 'processing', которого нет в CHECK, и глушил отказ
 * пустым catch. Кнопки, которая бы его звала, не было вовсе.
 *
 * ── Что теперь (решение владельца 26.09) ───────────────────────────────────
 * Доступно только ОДОБРЕННОМУ агенту (requireApprovedAgent). В заявку входят
 * продажи в состоянии «к выплате» из единственной функции денег агента:
 * оплачены, не отменены, конец тура + 36 ч прошёл, ещё не запрошены и не
 * выплачены. Сумма и ставка каждой брони фиксируются снимком
 * (agent_payout_items) — смена ставки их не перепишет.
 *
 * Всё в одной транзакции, и запись агента берётся FOR UPDATE: две заявки
 * одного агента выстраиваются в очередь, вторая дожидается и честно получает
 * «уже есть открытая заявка». SKIP LOCKED здесь не годится — он пропустил бы
 * занятое и создал пустую или частичную заявку вместо отказа. Страховка в
 * базе — два уникальных индекса миграции 1026: одна открытая заявка на
 * агента, одна живая позиция на бронь (дважды не выплатить).
 *
 * Деньги переводит администратор вне платформы и отмечает факт с
 * основанием (/api/admin/agent-commission/payouts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { transaction } from '@/lib/database';
import { requireApprovedAgent } from '@/lib/auth/agent-approval';
import {
  AGENT_MONEY_SQL, loadAgentMoney, payableForRequest, logAgentMoneyFailure, sqlstateOf,
} from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

const RequestPayoutSchema = z.object({
  paymentMethod: z.enum(['bank_transfer', 'card', 'sbp']).default('bank_transfer'),
  comment: z.string().trim().max(500).optional(),
});

type Outcome =
  | { kind: 'ok'; payoutId: string; createdAt: string; totalAmount: number; bookingCount: number }
  | { kind: 'reject'; status: number; error: string };

export async function POST(request: NextRequest) {
  const auth = await requireApprovedAgent(request);
  if (auth instanceof NextResponse) return auth;

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = RequestPayoutSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const { paymentMethod, comment } = parsed.data;

  try {
    const outcome = await transaction<Outcome>(async (client) => {
      // Замок на записи агента — первым запросом: дальше всё под ним.
      const money = await loadAgentMoney(client, auth.userId, true);
      if (!money.profile) {
        return { kind: 'reject', status: 409, error: 'Профиль агента не найден — заполните его в кабинете' };
      }
      if (money.rate === null) {
        return { kind: 'reject', status: 409, error: 'Ставка вознаграждения не назначена — выплату запросить нельзя' };
      }

      const open = await client.query<{ id: string }>(AGENT_MONEY_SQL.openPayout, [auth.userId]);
      if (open.rows.length > 0) {
        return { kind: 'reject', status: 409, error: 'У вас уже есть открытая заявка на выплату — дождитесь решения администратора' };
      }

      const items = payableForRequest(money.sales);
      const total = Math.round(items.reduce((s, i) => s + (i.amount ?? 0), 0) * 100) / 100;
      if (items.length === 0 || total <= 0) {
        return { kind: 'reject', status: 400, error: 'Нет продаж, готовых к выплате' };
      }

      const payout = await client.query<{ id: string; created_at: string }>(
        AGENT_MONEY_SQL.insertPayout,
        [auth.userId, total, paymentMethod, comment ?? null],
      );
      const payoutId = payout.rows[0].id;
      await client.query(AGENT_MONEY_SQL.insertItems, [
        payoutId,
        auth.userId,
        items.map((i) => i.bookingId),
        items.map((i) => i.saleAmount),
        items.map((i) => i.rate),
        items.map((i) => i.amount),
      ]);

      return { kind: 'ok', payoutId, createdAt: payout.rows[0].created_at, totalAmount: total, bookingCount: items.length };
    });

    if (outcome.kind === 'reject') {
      return NextResponse.json({ success: false, error: outcome.error }, { status: outcome.status });
    }
    return NextResponse.json({
      success: true,
      data: {
        payoutId: outcome.payoutId,
        totalAmount: outcome.totalAmount,
        bookingCount: outcome.bookingCount,
        createdAt: outcome.createdAt,
      },
      message: 'Заявка на выплату отправлена администратору',
    });
  } catch (err) {
    // 23505 — сработал уникальный индекс: параллельная заявка успела первой.
    if (sqlstateOf(err) === '23505') {
      return NextResponse.json(
        { success: false, error: 'Заявка уже создана или брони уже запрошены — обновите страницу' },
        { status: 409 },
      );
    }
    logAgentMoneyFailure('POST /api/agent/commissions/request-payout', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось создать заявку на выплату', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
