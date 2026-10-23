/**
 * Данные страницы перевозчика /transfers/[slug] — стандарт карточки трансфера
 * (решение владельца 13.10, «да делай»; CLAUDE.md §14).
 *
 * Части с тремя исходами каждая, а не одна «загрузилось/нет»:
 *   · перевозчик — нашли / такого нет (404) / не смогли проверить (исключение,
 *     страница падает в ошибку, а не рисует «перевозчика нет»);
 *   · опасности мест по направлениям — по месту / место без профиля
 *     («не записаны» ≠ «безопасно») / не смогли;
 *   · отзывы — список со сводкой по видимым / пусто / не смогли (миграция
 *     1235, lib/transfers/carrier-reviews);
 *   · прокат — есть ли у партнёра живой прайс машин без водителя (схема 1317,
 *     23.10): есть — ссылка на страницу проката / нет / не смогли (ссылки нет,
 *     отказ в логе).
 * Отказ второстепенной части не роняет страницу: прайс и заявка важнее.
 *
 * Поездок с местами здесь нет (владелец 13.10: «бронируют целую машину а не
 * место в ней»): модуль мест (схема 926) спрятан, страница его не читает.
 */

import { query } from '@/lib/database';
import { loadCarrierBySlug } from '@/lib/transfers/charter';
import type { CarrierProfile } from '@/lib/transfers/charter-format';
import { logText } from '@/lib/log/log-text';
import { asProfileSource, mayStateAsFact } from '@/lib/safety/profile-source';
import { loadCarrierReviews, type CarrierReviewsBlock } from '@/lib/transfers/carrier-reviews';
import { partnerHasRentalOffers } from '@/lib/rental/rental';
import { rentalHiddenOnSite } from '@/lib/rental/site-pause';

/** placeId → опасности; места без профиля безопасности в карте нет. */
export type DestinationSafety = { state: 'ok'; byPlace: Record<string, string[]> } | { state: 'failed' };

/** У партнёра есть живой прайс проката (машины без водителя, 1317) — или не смогли проверить. */
export type CarrierRentalLink = { state: 'ok'; has: boolean } | { state: 'failed' };

export interface CarrierPageData {
  carrier: CarrierProfile;
  safety: DestinationSafety;
  reviews: CarrierReviewsBlock;
  rental: CarrierRentalLink;
}

function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[transfers/carrier-page] ${what}: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
    logText(err instanceof Error ? err.message : err, 200),
  );
}

/**
 * Опасности мест, куда идёт машина: location_safety_profile по ark_id места —
 * тот же источник, что у карточки места (§9). Профилей у места может быть
 * несколько — опасности объединяются, порядок первого появления.
 *
 * Опасности, доказанно пришедшие шаблоном по типу места (миграция 070:
 * «вулкан — лавины, камнепад, термальные, высота»), как факт не произносятся
 * (lib/safety/profile-source): у такого места — «не записаны», как и у места
 * без профиля.
 */
async function loadDestinationSafety(placeIds: string[]): Promise<DestinationSafety> {
  if (placeIds.length === 0) return { state: 'ok', byPlace: {} };
  try {
    const { rows } = await query<{ place_id: string; hazard_types: string[] | null; profile_source: unknown }>(
      `SELECT pl.id AS place_id, lsp.hazard_types, lsp.profile_source
         FROM places pl
         JOIN location_safety_profile lsp ON lsp.agent_route_id = pl.ark_id
        WHERE pl.id = ANY($1::text[])`,
      [placeIds],
    );
    const byPlace: Record<string, string[]> = {};
    for (const r of rows) {
      if (!mayStateAsFact(asProfileSource(r.profile_source))) continue;
      const list = byPlace[r.place_id] ?? (byPlace[r.place_id] = []);
      for (const h of r.hazard_types ?? []) if (h && !list.includes(h)) list.push(h);
    }
    return { state: 'ok', byPlace };
  } catch (err) {
    logFailure('опасности мест не прочитаны', err);
    return { state: 'failed' };
  }
}

/**
 * Есть ли у перевозчика прайс проката: отказ — «не смогли», не «нет».
 * Прокат партнёра под паузой (lib/rental/site-pause, слово владельца 23.10)
 * со страницы трансфера не ведёт: страница — сайт, а пауза прячет прокат
 * от людей на сайте; базу тогда не спрашиваем вовсе.
 */
async function loadRentalLink(partnerId: string, slug: string): Promise<CarrierRentalLink> {
  if (rentalHiddenOnSite(slug)) return { state: 'ok', has: false };
  try {
    return { state: 'ok', has: await partnerHasRentalOffers(partnerId) };
  } catch (err) {
    logFailure('прайс проката не прочитан', err);
    return { state: 'failed' };
  }
}

/** null — такого перевозчика нет; отказ чтения перевозчика — исключение. */
export async function loadCarrierPage(slug: string): Promise<CarrierPageData | null> {
  const carrier = await loadCarrierBySlug(slug);
  if (!carrier) return null;
  const placeIds = [...new Set(carrier.destinations.flatMap((d) => (d.place ? [d.place.id] : [])))];
  const [safety, reviews, rental] = await Promise.all([
    loadDestinationSafety(placeIds),
    loadCarrierReviews(carrier.partnerId),
    loadRentalLink(carrier.partnerId, carrier.slug),
  ]);
  return { carrier, safety, reviews, rental };
}
