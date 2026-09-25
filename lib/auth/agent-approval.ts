/**
 * Гейт кабинета агента: продавать может только ОДОБРЕННЫЙ агент.
 *
 * Решение владельца 26.09: агент работает после одобрения администратором.
 * Роль `agent` выдаёт самостоятельная регистрация, то есть сама по себе она
 * ничего не доказывает — одобрение живёт в `partners.profile_status` строки
 * `category = 'agent'` этого пользователя.
 *
 * Три исхода, а не два (§4.0):
 *   - одобрен (или администратор) — пропускаем, отдаём JWT;
 *   - не одобрен / строки нет — 403 с объяснением, что делать;
 *   - база не ответила — 503 и строка в лог с SQLSTATE. «Не смогли
 *     проверить» не выдаётся ни за «одобрен», ни за «не одобрен».
 *
 * Контракт общий с пакетом «деньги агента» (сигнатура и тексты те же); если
 * оба пакета принесут этот файл, сводится один.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import type { JWTPayload } from '@/lib/auth/jwt';
import { requireAgent } from '@/lib/auth/middleware';

export const AGENT_NOT_APPROVED_MESSAGE =
  'Кабинет агента откроется после одобрения администратором';

export async function requireApprovedAgent(
  req: NextRequest,
): Promise<JWTPayload | NextResponse> {
  const userOrResponse = await requireAgent(req);
  if (userOrResponse instanceof NextResponse) return userOrResponse;
  if (userOrResponse.role === 'admin') return userOrResponse;

  try {
    const { rows } = await pool.query<{ profile_status: string }>(
      `SELECT profile_status
         FROM partners
        WHERE user_id = $1 AND category = 'agent'
        LIMIT 1`,
      [userOrResponse.userId],
    );
    if (rows[0]?.profile_status === 'approved') return userOrResponse;
    return NextResponse.json(
      { success: false, error: AGENT_NOT_APPROVED_MESSAGE },
      { status: 403 },
    );
  } catch (err) {
    const sqlstate = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(
      `[agent-approval] одобрение агента не проверено, SQLSTATE ${sqlstate}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { success: false, error: 'Не удалось проверить доступ агента. Попробуйте позже.' },
      { status: 503 },
    );
  }
}
