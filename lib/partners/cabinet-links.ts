/**
 * Куда вести продавца тура из его личного сообщения о брони или заявке.
 *
 * Свои туры продаёт не только туроператор: гид с авторскими турами (1338)
 * продаёт их со своей карточки гида и работает в кабинете гида.
 * Кабинет оператора его не пустит (`operatorAccess` требует категорию
 * 'operator'), и кнопка «Открыть бронь» в MAX вела бы его на отказ. Брони,
 * заявки и даты гида — в разделе «Свои туры» (`/hub/guide/own`).
 *
 * Категория неизвестна (не прочиталась, не передана) — ссылка в кабинет
 * оператора, как было до 28.10: так она ведёт верно всех, кроме гида.
 * Категорию для личного сообщения о заявке приносит `reachForPartner`
 * (lib/partners/reach) — тем же запросом, что и адрес.
 */
import { getPublicBaseUrl } from '@/lib/config';

/** Раздел гида: брони, заявки и даты его собственных туров. */
export const GUIDE_OWN_PATH = '/hub/guide/own';

function isGuide(category: string | null | undefined): boolean {
  return category === 'guide';
}

/**
 * Раздел броней продавца — путь без домена: для экранов кабинета и
 * «Входящих» (lib/crm/inbox-kinds), где ссылка относительная.
 */
export function ownerBookingsPath(category: string | null | undefined): string {
  return isGuide(category) ? GUIDE_OWN_PATH : '/hub/operator/bookings';
}

/** Раздел заявок продавца — путь без домена. */
export function ownerLeadsPath(category: string | null | undefined): string {
  return isGuide(category) ? GUIDE_OWN_PATH : '/hub/operator/leads';
}

/** Одна бронь — у оператора своя страница, у гида общий раздел. */
export function ownerBookingsUrl(category: string | null | undefined, bookingId: bigint | string): string {
  return isGuide(category)
    ? `${getPublicBaseUrl()}${GUIDE_OWN_PATH}`
    : `${getPublicBaseUrl()}${ownerBookingsPath(category)}/${bookingId}`;
}

/** Список броней. */
export function ownerBookingsListUrl(category: string | null | undefined): string {
  return `${getPublicBaseUrl()}${ownerBookingsPath(category)}`;
}

/** Одна заявка (лид). */
export function ownerLeadUrl(category: string | null | undefined, leadId: string): string {
  return isGuide(category)
    ? `${getPublicBaseUrl()}${GUIDE_OWN_PATH}`
    : `${getPublicBaseUrl()}${ownerLeadsPath(category)}/${leadId}`;
}
