import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const StatusSchema = z.enum(['all', 'pending', 'confirmed', 'expired']).default('pending');

export async function GET(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  const parsedStatus = StatusSchema.safeParse(request.nextUrl.searchParams.get('status') ?? undefined);
  if (!parsedStatus.success) {
    return NextResponse.json({ error: 'Некорректный статус' }, { status: 400 });
  }
  const status = parsedStatus.data;

  const { rows } = await pool.query<{
    payment_id: string;
    query_type: string;
    query_params: Record<string, unknown>;
    price_usdt: string;
    wallet_to: string;
    tx_id: string | null;
    status: string;
    expires_at: string;
    created_at: string;
    confirmed_at: string | null;
    confirmed_by: string | null;
  }>(
    `SELECT payment_id, query_type, query_params, price_usdt, wallet_to,
            tx_id, status, expires_at, created_at, confirmed_at, confirmed_by
     FROM agent_market_payments
     WHERE ($1 = 'all' OR status = $1)
     ORDER BY created_at DESC
     LIMIT 100`,
    [status],
  );

  return NextResponse.json({ payments: rows, count: rows.length });
}

// confirmed_by больше не принимается телом: кто подтвердил — это
// администратор из JWT, а не строка, которую прислал клиент (26.09).
const ConfirmSchema = z.object({
  payment_id: z.string().uuid(),
  tx_id: z.string().trim().max(200).optional(),
});

export async function POST(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const parsed = ConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ошибка валидации', details: parsed.error.flatten() }, { status: 422 });
  }

  const { payment_id, tx_id } = parsed.data;

  // Подтверждается только ещё не истёкший платёж: истёкший ответ API уже
  // заменил новым payment_id, и подтверждение старого открыло бы данные по
  // платежу, срок которого вышел.
  const { rowCount } = await pool.query(
    `UPDATE agent_market_payments
     SET status = 'confirmed', confirmed_at = NOW(), confirmed_by = $2, tx_id = $3
     WHERE payment_id = $1 AND status = 'pending' AND expires_at > NOW()`,
    [payment_id, authError.userId, tx_id ?? null],
  );

  if (!rowCount) {
    return NextResponse.json({ error: 'Платёж не найден, уже обработан или его срок истёк' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, payment_id, status: 'confirmed' });
}
