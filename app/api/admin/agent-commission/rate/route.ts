/**
 * GET  /api/admin/agent-commission/rate — агенты: ставка и статус одобрения
 * POST /api/admin/agent-commission/rate — назначить агенту ставку
 *
 * Это рука ВЛАДЕЛЬЦА, а не механизм платформы: процент назначает человек и
 * применяет его своим решением. Платформа тут только записывает — кто, что,
 * когда и на каком основании (решение владельца 26.09).
 *
 * ── Одна ставка на агента ──────────────────────────────────────────────────
 * До 26.09 ставка жила на реферальной ссылке (POST
 * /api/admin/agent-referral/rate). У брони, оформленной агентом за клиента,
 * ссылки нет — такие продажи остались бы без ставки навсегда. Теперь ставка
 * одна, на записи агента (partners.agent_commission_rate, миграция 1025), и
 * её читает единственная функция денег агента. Прежняя рука ссылок снята,
 * ставки ссылок перенесены миграцией там, где перенос однозначен.
 *
 * ── Основание обязательно ──────────────────────────────────────────────────
 * Ставка — денежное решение, и через месяц никто не вспомнит, откуда взялись
 * эти проценты. `reason` называет договорённость, а не галочку.
 *
 * Ноль разрешён: «вознаграждения нет» — законное решение, и оно не равно
 * «не назначена» (§7, «ноль — не пустота»). NULL снимает ставку — это тоже
 * решение человека и тоже с основанием. Уже запрошенное и выплаченное смена
 * ставки не трогает: там снимок (agent_payout_items).
 *
 * Ставка платформы с оператора этим роутом не трогается — другая величина
 * другой стороны, она живёт под §7 своим сторожем.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { AGENT_MONEY_SQL, AGENT_RATE_MAX, logAgentMoneyFailure, sqlstateOf } from '@/lib/payments/agent-commission';

export const dynamic = 'force-dynamic';

const SetRateSchema = z.object({
  partnerId: z.string().uuid('Некорректный идентификатор агента'),
  rate: z.number().min(0).max(AGENT_RATE_MAX).nullable(),
  reason: z.string().trim()
    .min(8, 'Назовите основание: договорённость, письмо, дату — не галочку')
    .max(500),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { rows } = await pool.query(AGENT_MONEY_SQL.adminAgents);
    return NextResponse.json({ success: true, data: { agents: rows } });
  } catch (err) {
    logAgentMoneyFailure('GET /api/admin/agent-commission/rate', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось получить агентов', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });
  const parsed = SetRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const { partnerId, rate, reason } = parsed.data;

  try {
    const { rows } = await pool.query<{ partner_id: string; rate: string | null }>(
      AGENT_MONEY_SQL.setRate, [partnerId, rate, auth.userId, reason],
    );
    // Записи агента нет — отказ, а не тихий ноль изменённых строк.
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Агент не найден — ставка не назначена' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      data: { partnerId: rows[0].partner_id, rate: rows[0].rate === null ? null : Number(rows[0].rate) },
    });
  } catch (err) {
    logAgentMoneyFailure('POST /api/admin/agent-commission/rate', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось назначить ставку', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
}
