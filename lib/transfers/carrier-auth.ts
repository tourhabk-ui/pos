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

export const CARRIER_ROLES = ['transfer', 'transfer_operator', 'cars'] as const;

/** Роль проката автомобилей: в кабинете перевозчика ей открыт только раздел «Прокат». */
export const RENTAL_ROLE = 'cars';

/** Отказ прокатчику в разделах перевозчика — словами, что ему открыто. */
export const RENTAL_ONLY_TEXT =
  'Этот раздел — для перевозчиков (машина с водителем). В вашем кабинете — раздел «Прокат».';

export interface Carrier {
  user: JWTPayload;
  partnerId: string;
  /** Категория карточки, с которой открыт кабинет. */
  category: 'transfer' | 'cars';
}

/**
 * Кабинет перевозчика и проката. `rental: true` ставят только роуты раздела
 * «Прокат»: прокатчику автомобилей (роль `cars`, 23.11) открыты они одни.
 *
 * Разделы перевозчика — парк, прайс «под заказ», заявки на машину с
 * водителем — ему закрыты отказом 403, а не скрыты одной вёрсткой: страница
 * перевозчика `/transfers/[slug]` есть только у категории `transfer`, и
 * строка прайса «под заказ» у карточки проката вела бы со списка перевозчиков
 * на 404.
 */
export async function requireCarrier(
  request: NextRequest,
  opts: { rental?: boolean } = {},
): Promise<Carrier | NextResponse> {
  const auth = await requireRole(request, [...CARRIER_ROLES]);
  if (auth instanceof NextResponse) return auth;

  const category = auth.role === RENTAL_ROLE ? 'cars' : 'transfer';
  if (category === 'cars' && !opts.rental) {
    return NextResponse.json({ success: false, error: RENTAL_ONLY_TEXT }, { status: 403 });
  }

  let partnerId: string | null;
  try {
    // Категория профиля — по роли: у проката 'cars', у перевозчика 'transfer'
    // (устаревшая роль transfer_operator в PARTNER_ROLES не значится, и
    // профиль под ней не заведётся никогда).
    partnerId = await ensurePartnerForRole(auth.userId, category);
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
  return { user: auth, partnerId, category };
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
