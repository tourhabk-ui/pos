/**
 * Stay (accommodation) Helper Functions
 * Утилиты для владельцев жилья: партнёр category='stay'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';

/**
 * Партнёрский профиль владельца жилья по user_id.
 */
export async function getStayPartnerId(userId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT id FROM partners
       WHERE user_id = $1 AND category = 'stay'
       LIMIT 1`,
      [userId]
    );

    return (result.rows[0]?.id as string | undefined) ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Общий гвард owner-эндпоинтов жилья: авторизация + владение объектом
 * (admin — в обход). Возвращает JWTPayload либо готовый NextResponse.
 */
export async function requireAccommodationAccess(
  request: NextRequest,
  accommodationId: string
): Promise<JWTPayload | NextResponse> {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const isOwner = await verifyAccommodationOwnership(authResult.userId, accommodationId);
  if (!isOwner && authResult.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Объект не найден или нет прав' },
      { status: 404 }
    );
  }
  return authResult;
}

/**
 * Проверка владения объектом размещения.
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
    return false;
  }
}
