/**
 * Кто такой перевозчик для API кабинета.
 *
 * Роль в JWT — `transfer` либо устаревшее `transfer_operator` (middleware
 * считает их одной ролью, см. roleMatches). Партнёрский профиль живёт в
 * `partners` с category = 'transfer' (PARTNER_ROLES), и без него кабинет
 * пуст: парк и поездки привязаны к partner_id, не к user_id. Поэтому профиль
 * не ищется, а ГАРАНТИРУЕТСЯ — тем же ensurePartnerForRole, что чинил
 * запертую дверь регистрации (CLAUDE.md §4.0, случай 24.08).
 *
 * Возвращает либо ответ-отказ (401/403/404), либо пару user + partnerId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';

export const CARRIER_ROLES = ['transfer', 'transfer_operator'] as const;

export interface Carrier {
  user: JWTPayload;
  partnerId: string;
}

export async function requireCarrier(request: NextRequest): Promise<Carrier | NextResponse> {
  const auth = await requireRole(request, [...CARRIER_ROLES]);
  if (auth instanceof NextResponse) return auth;

  let partnerId: string | null;
  try {
    // Категория профиля — всегда 'transfer': устаревшая роль transfer_operator
    // в PARTNER_ROLES не значится, и профиль под ней не заведётся никогда.
    partnerId = await ensurePartnerForRole(auth.userId, 'transfer');
  } catch (err) {
    console.error('[carrier-auth] ensurePartnerForRole:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось открыть профиль перевозчика — попробуйте позже' },
      { status: 503 },
    );
  }
  if (!partnerId) {
    return NextResponse.json(
      { success: false, error: 'Профиль перевозчика не найден' },
      { status: 404 },
    );
  }
  return { user: auth, partnerId };
}

/** Единый перевод исхода сервиса в HTTP-статус: имя исхода — в ответе. */
export const FAILURE_STATUS: Record<string, number> = {
  vehicle_not_found: 404,
  trip_not_found: 404,
  booking_not_found: 404,
  not_your_vehicle: 403,
  vehicle_inactive: 409,
  seats_over_capacity: 409,
  day_taken: 409,
  trip_not_open: 409,
  not_enough_seats: 409,
  wrong_status: 409,
  db_error: 503,
};
