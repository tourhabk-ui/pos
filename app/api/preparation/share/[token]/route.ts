/**
 * GET /api/preparation/share/[token] — прочитать брифинг похода.
 *
 * Публичный по токену: получатель не заводит аккаунт, чтобы узнать, когда
 * ждать человека обратно. Отдаём только снимок (миграция 870) — ни
 * координат, ни личных данных в нём нет по устройству схемы.
 *
 * Просроченная и отозванная ссылка отвечают ЧЕСТНО и по-разному: «срок
 * истёк» — это не «маршрута не существует», и человек снаружи должен
 * понимать, что перед ним, а не гадать по 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ success: false, error: 'Неверная ссылка' }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<{
      snapshot: unknown;
      expires_at: string;
      revoked_at: string | null;
      created_at: string;
    }>(
      `SELECT snapshot, expires_at, revoked_at, created_at
         FROM trip_preparation_shares
        WHERE token = $1
        LIMIT 1`,
      [token],
    );

    const row = rows[0];
    if (!row) {
      return NextResponse.json({ success: false, error: 'Брифинг не найден' }, { status: 404 });
    }
    if (row.revoked_at) {
      return NextResponse.json(
        { success: false, error: 'Ссылка отозвана автором', reason: 'revoked' },
        { status: 410 },
      );
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      return NextResponse.json(
        { success: false, error: 'Срок действия ссылки истёк', reason: 'expired' },
        { status: 410 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        snapshot: row.snapshot,
        sharedAt: row.created_at,
        expiresAt: row.expires_at,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
