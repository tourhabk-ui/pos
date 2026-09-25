/**
 * GET  /api/admin/agent-commission/payouts — заявки агентов на выплату
 *      + выплаченные позиции, чья бронь отменена позже (флаг администратору)
 * POST /api/admin/agent-commission/payouts — отметить заявку выплаченной
 *      или отклонить
 *
 * ── Что это, и чего это НЕ делает ──────────────────────────────────────────
 * Решение владельца 26.09: вознаграждение агенту переводит администратор ВНЕ
 * платформы, а этот роут фиксирует факт — кто, когда и на каком основании.
 * Тот же порядок, что у возврата туристу (/api/admin/finance/refunds):
 * `reason` обязателен и должен называть подтверждение перевода (номер
 * операции, скриншот), а не быть галочкой — «отметил и забыл» здесь стоит
 * денег.
 *
 * ── Предохранители ─────────────────────────────────────────────────────────
 * 1. Заявка берётся FOR UPDATE и должна быть в `pending`: две отметки одной
 *    заявки не пройдут обе.
 * 2. Перед отметкой «выплачено» позиции проверяются заново: бронь, отменённая
 *    или возвращённая ПОСЛЕ заявки, либо тур, перенесённый так, что срок
 *    выплаты ещё не наступил, — отказ 409 со списком. Заявку тогда
 *    отклоняют, позиции освобождаются, агент запрашивает заново уже без них.
 *    Частичной отметки нет: заплатить часть и промолчать про остальное
 *    нельзя.
 * 3. Отмена ПОСЛЕ выплаты не уводит агента в минус молча — такие позиции
 *    GET отдаёт отдельным списком, решение за человеком.
 *
 * Гейт `/api/admin/*` — admin-JWT (§7).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';
import {
  AGENT_MONEY_SQL, PAYOUT_STATUSES, logAgentMoneyFailure, sqlstateOf,
} from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['all', ...PAYOUT_STATUSES]).default('pending'),
});

const ActionSchema = z.object({
  payoutId: z.string().uuid('Некорректный идентификатор заявки'),
  action: z.enum(['mark_paid', 'reject']),
  reason: z.string().trim()
    .min(8, 'Опишите основание: для выплаты — подтверждение перевода (номер операции, скриншот), для отказа — причину')
    .max(500),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const parsed = QuerySchema.safeParse({ status: request.nextUrl.searchParams.get('status') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры запроса' }, { status: 400 });
  }
  const status = parsed.data.status === 'all' ? null : parsed.data.status;

  try {
    const [payouts, flagged] = await Promise.all([
      pool.query(AGENT_MONEY_SQL.adminPayouts, [status, CANCELLED_STATUS_PARAM]),
      pool.query(AGENT_MONEY_SQL.cancelledAfterPayout, [CANCELLED_STATUS_PARAM]),
    ]);
    return NextResponse.json({
      success: true,
      data: { payouts: payouts.rows, cancelledAfterPayout: flagged.rows },
    });
  } catch (err) {
    logAgentMoneyFailure('GET /api/admin/agent-commission/payouts', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось получить заявки агентов', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}

type Outcome = { ok: true } | { ok: false; status: number; error: string; bookings?: string[] };

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 422 },
    );
  }
  const { payoutId, action, reason } = parsed.data;

  try {
    const outcome = await transaction<Outcome>(async (client) => {
      const locked = await client.query<{ id: string; status: string }>(AGENT_MONEY_SQL.lockPayout, [payoutId]);
      const payout = locked.rows[0];
      if (!payout) return { ok: false, status: 404, error: 'Заявка не найдена' };
      if (payout.status !== 'pending') {
        return { ok: false, status: 409, error: `Заявка уже обработана (статус: ${payout.status})` };
      }

      if (action === 'reject') {
        await client.query(AGENT_MONEY_SQL.reject, [payoutId, auth.userId, reason]);
        await client.query(AGENT_MONEY_SQL.releaseItems, [payoutId]);
        return { ok: true };
      }

      const blockers = await client.query<{ booking_id: string; voided: boolean; not_released: boolean }>(
        AGENT_MONEY_SQL.payoutBlockers, [payoutId, CANCELLED_STATUS_PARAM],
      );
      if (blockers.rows.length > 0) {
        return {
          ok: false,
          status: 409,
          error: 'Часть броней в заявке больше не готова к выплате (отменена, возвращена или тур перенесён). '
            + 'Отклоните заявку — агент запросит выплату заново без них.',
          bookings: blockers.rows.map((b) => b.booking_id),
        };
      }
      await client.query(AGENT_MONEY_SQL.markPaid, [payoutId, auth.userId, reason]);
      return { ok: true };
    });

    if (!outcome.ok) {
      return NextResponse.json(
        { success: false, error: outcome.error, ...(outcome.bookings ? { bookings: outcome.bookings } : {}) },
        { status: outcome.status },
      );
    }
    return NextResponse.json({
      success: true,
      message: action === 'mark_paid' ? 'Выплата отмечена' : 'Заявка отклонена, брони освобождены',
    });
  } catch (err) {
    logAgentMoneyFailure('POST /api/admin/agent-commission/payouts', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось обработать заявку', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
