/**
 * GET /api/hub/operator/leads/report — отчёт партнёру по входящему спросу
 * (Рост-5, стратегия 14.08: продавать партнёру измеримый входящий спрос).
 *
 * Отвечает на «сколько лидов пришло, откуда, что с ними стало» — только
 * счётчики, без ПД туристов (имена/телефоны в отчёте не нужны и не отдаются).
 *
 * Скоуп: оператор видит СВОИ лиды (operator_id = его partner.id); общий пул
 * ничейных показан отдельным числом и явно назван пулом, а не его спросом.
 * Атрибуция оператора детерминированная (lib/leads/create.ts): виджет
 * партнёра либо маршрут, туры по которому есть ровно у одного оператора —
 * отчёт говорит об этом словами в attribution_note, чтобы цифра не выглядела
 * полнее, чем она есть. Канал — leads.source_channel (lib/leads/channel.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperator } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

interface CountRow { key: string | null; d7: string; d30: string }

export async function GET(request: NextRequest) {
  const authResult = await requireOperator(request);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult as JWTPayload;

  // Оператор — только свой отчёт; админ может посмотреть любого партнёра.
  let operatorId: string | null = null;
  if (user.role === 'admin') {
    operatorId = new URL(request.url).searchParams.get('operator_id');
    if (!operatorId) {
      return NextResponse.json(
        { error: 'Укажите operator_id — отчёт строится по одному партнёру' },
        { status: 400 },
      );
    }
  } else {
    const opRes = await pool.query<{ id: string }>(
      'SELECT id FROM partners WHERE user_id = $1 LIMIT 1',
      [user.userId],
    );
    operatorId = opRes.rows[0]?.id ?? null;
    if (!operatorId) {
      return NextResponse.json(
        { error: 'Партнёрский профиль не найден' },
        { status: 404 },
      );
    }
  }

  try {
    const [byChannel, byStatus, daily, pool30] = await Promise.all([
      pool.query<CountRow>(
        `SELECT source_channel AS key,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS d7,
                COUNT(*)::text AS d30
           FROM leads
          WHERE operator_id = $1 AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY source_channel ORDER BY COUNT(*) DESC`,
        [operatorId],
      ),
      pool.query<CountRow>(
        `SELECT status AS key,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS d7,
                COUNT(*)::text AS d30
           FROM leads
          WHERE operator_id = $1 AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY status ORDER BY COUNT(*) DESC`,
        [operatorId],
      ),
      pool.query<{ day: string; count: string }>(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::text AS count
           FROM leads
          WHERE operator_id = $1 AND created_at > NOW() - INTERVAL '14 days'
          GROUP BY created_at::date ORDER BY created_at::date`,
        [operatorId],
      ),
      // Общий пул: лиды без оператора. Это НЕ спрос конкретного партнёра —
      // отдельное число, чтобы кабинет мог показать «в пуле ещё N заявок».
      pool.query<{ d30: string }>(
        `SELECT COUNT(*)::text AS d30 FROM leads
          WHERE operator_id IS NULL AND created_at > NOW() - INTERVAL '30 days'`,
      ),
    ]);

    const sum = (rows: CountRow[], f: 'd7' | 'd30') =>
      rows.reduce((s, r) => s + Number(r[f]), 0);

    return NextResponse.json({
      operator_id: operatorId,
      totals: { d7: sum(byChannel.rows, 'd7'), d30: sum(byChannel.rows, 'd30') },
      by_channel_30d: byChannel.rows.map((r) => ({
        channel: r.key ?? 'not_attributed',
        d7: Number(r.d7),
        d30: Number(r.d30),
      })),
      by_status_30d: byStatus.rows.map((r) => ({
        status: r.key,
        d7: Number(r.d7),
        d30: Number(r.d30),
      })),
      daily_14d: daily.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
      unassigned_pool_30d: Number(pool30.rows[0]?.d30 ?? 0),
      attribution_note:
        'Лид привязывается к оператору детерминированно: виджет партнёра или ' +
        'маршрут, активные туры по которому есть ровно у одного оператора. ' +
        'Остальные заявки живут в общем пуле (unassigned_pool_30d) и в счётчики ' +
        'партнёра не входят.',
    });
  } catch {
    return NextResponse.json({ error: 'Не удалось построить отчёт' }, { status: 500 });
  }
}
