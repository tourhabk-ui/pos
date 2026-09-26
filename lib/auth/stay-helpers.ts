/**
 * Stay (accommodation) Helper Functions
 * Утилиты для владельцев жилья: партнёр category='stay'.
 *
 * У каждой проверки три исхода (§4.0): нашлось / не нашлось / НЕ СМОГЛИ
 * проверить. До 26.09 третий исход глушился пустым catch и выдавался за
 * второй: отказ базы превращался в 404 «Кабинет ещё не настроен» или
 * «Объект не найден». Теперь отказ пишется в лог (имя проверки + SQLSTATE)
 * и бросается `StayCheckUnavailableError` — вызывающий отвечает 503, а не
 * «у вас ничего нет».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import { logStayFailure, StayCheckUnavailableError } from '@/lib/stay/db-failure';

export { StayCheckUnavailableError } from '@/lib/stay/db-failure';

const uuidSchema = z.string().uuid();

/** Ответ на «не смогли проверить» — одинаковый у всех owner-роутов жилья. */
export function stayCheckUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Не удалось проверить доступ к кабинету — база не ответила. Попробуйте позже.' },
    { status: 503 }
  );
}

/**
 * Гвард роли владельца жилья — в пару к requireOperator/requireAgent.
 * Тот же набор ролей, что гейтит кабинет в layout (['stay','admin']):
 * гейт по роли явный, а не только по скоупу данных.
 */
export async function requireStayOwner(request: NextRequest): Promise<JWTPayload | NextResponse> {
  return requireRole(request, ['stay', 'admin']);
}

/**
 * Партнёрский профиль владельца жилья по user_id.
 * string — найден; null — профиля нет; бросает StayCheckUnavailableError —
 * база не ответила.
 *
 * ORDER BY created_at, id: у partners нет уникального индекса
 * (user_id, category), и при задвоенном профиле LIMIT 1 без порядка мог
 * отдавать разные строки от запроса к запросу — объекты «пропадали» бы.
 * Берётся самый ранний: к нему привязаны объекты, заведённые первыми.
 */
export async function getStayPartnerId(userId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT id FROM partners
       WHERE user_id = $1 AND category = 'stay'
       ORDER BY created_at ASC NULLS LAST, id ASC
       LIMIT 1`,
      [userId]
    );

    return (result.rows[0]?.id as string | undefined) ?? null;
  } catch (error) {
    logStayFailure('getStayPartnerId', error);
    throw new StayCheckUnavailableError('getStayPartnerId', error);
  }
}

/**
 * Общий гвард owner-эндпоинтов жилья: авторизация + владение объектом
 * (admin — в обход). Возвращает JWTPayload либо готовый NextResponse:
 * 400 — id не uuid, 404 — не свой/нет, 503 — не смогли проверить.
 */
export async function requireAccommodationAccess(
  request: NextRequest,
  accommodationId: string
): Promise<JWTPayload | NextResponse> {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  if (!uuidSchema.safeParse(accommodationId).success) {
    return NextResponse.json(
      { success: false, error: 'Некорректный ID объекта' },
      { status: 400 }
    );
  }

  if (authResult.role === 'admin') return authResult;

  let isOwner: boolean;
  try {
    isOwner = await verifyAccommodationOwnership(authResult.userId, accommodationId);
  } catch (error) {
    if (error instanceof StayCheckUnavailableError) return stayCheckUnavailableResponse();
    throw error;
  }
  if (!isOwner) {
    return NextResponse.json(
      { success: false, error: 'Объект не найден или нет прав' },
      { status: 404 }
    );
  }
  return authResult;
}

/**
 * Проверка владения объектом размещения.
 * true — свой; false — не свой или нет; бросает StayCheckUnavailableError —
 * база не ответила.
 */
export async function verifyAccommodationOwnership(userId: string, accommodationId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT a.id
       FROM accommodations a
       JOIN partners p ON a.partner_id = p.id
       WHERE p.user_id = $1 AND p.category = 'stay' AND a.id = $2`,
      [userId, accommodationId]
    );

    return result.rows.length > 0;
  } catch (error) {
    logStayFailure('verifyAccommodationOwnership', error);
    throw new StayCheckUnavailableError('verifyAccommodationOwnership', error);
  }
}
