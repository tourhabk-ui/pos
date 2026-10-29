/**
 * lib/home/plate-facts.ts
 *
 * Строка фактов карточки тура на мобильной главной:
 * «от 13 000 ₽ /чел. · 10 ч · Камчатка Семейный Рафтинг».
 *
 * Аудит 24.09 (#39/#122): карточки главной писали «от 13 000 ₽ · тур
 * оператора» — без единицы цены, без длительности и без имени оператора, хотя
 * десктопная карточка того же тура все три факта показывала. «Тур оператора»
 * вместо имени — слово-заглушка там, где в базе лежит настоящее имя.
 *
 * Правило §4.0: факт, которого нет в данных, из строки выпадает, а не
 * подменяется. Нет цены — `price: null`, и вызывающий говорит словами
 * «Цена по запросу». Единица цены и длительность считаются теми же правилами,
 * что в каталоге (`priceUnitLabel`, форма длительности MarketplaceClient),
 * чтобы один тур не назывался на двух экранах по-разному.
 */

import { priceFrom } from '@/lib/tours/price-label';
import { priceUnitLabel } from '@/lib/tours/labels';
import { plural } from '@/lib/home/data-freshness';
import type { CatalogAvailability } from '@/lib/tours/catalog-availability';
import {
  groupOffersByCompany, offerOrderDay, roundRobinByCompany, type OfferOrderOptions,
} from '@/lib/tours/offer-order';

export interface PlateFactsInput {
  priceFrom: number | null;
  priceUnit: string | null;
  durationType: string | null;
  multiDayCount: number | null;
  durationHours: number | null;
  operatorName: string | null;
}

export interface PlateFacts {
  /** «от 13 000 ₽ /чел.» либо null — цены нет. */
  price: string | null;
  /** «10 ч», «2 дня», «Полдня» либо null — длительность не записана. */
  duration: string | null;
  operator: string | null;
}

/** Та же форма, что у карточки каталога (MarketplaceClient.formatDuration). */
export function plateDuration(t: Pick<PlateFactsInput, 'durationType' | 'multiDayCount' | 'durationHours'>): string | null {
  if (t.durationType === 'multi_day' && t.multiDayCount && t.multiDayCount > 0) {
    const d = t.multiDayCount;
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  if (t.durationType === 'half_day') return 'Полдня';
  if (t.durationType === 'day') return '1 день';
  const h = t.durationHours == null ? NaN : Number(t.durationHours);
  if (!Number.isFinite(h) || h <= 0) return null;
  if (h < 24) return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10} ч`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
}

export function plateFacts(p: PlateFactsInput): PlateFacts {
  const operator = p.operatorName?.trim() ? p.operatorName.trim() : null;
  return {
    price: priceFrom(p.priceFrom, `₽ ${priceUnitLabel(p.priceUnit, true)}`),
    duration: plateDuration(p),
    operator,
  };
}

/** Сколько туров помещается на витрину главной. */
export const PLATES_LIMIT = 8;

/** Порядок витрины по сезону: открытые (даты есть или по запросу) → сезон кончился (в конец). */
export const AVAILABILITY_RANK: Record<CatalogAvailability, number> = { dates: 0, on_request: 1, season_over: 2 };

/**
 * Подпись порядка блока туров главной (правило 1в, слово владельца 29.10):
 * порядок, круг компаний и конец для кончившегося сезона. Стоит под лентой.
 * Допуск по снимку называет своя подпись (`HOME_TOURS_PHOTO_NOTE`) над лентой —
 * обе видны на телефоне и на десктопе, текст не повторяется.
 */
export const HOME_PLATES_ORDER_NOTE =
  'Порядок: сначала туры со свободными местами — по ближайшему выезду, компании по очереди; остальные раз в сутки меняются местами по жребию, туры с закончившимся сезоном — в конце. Место в списке не продаётся.';

/**
 * Подпись допуска витрины главной (29.10, #2832, слово владельца «фото не
 * потянулись?»): правило отбора называется словами там же, где оно действует
 * (CLAUDE.md §0 — правило общих витрин говорится туристу на самой странице).
 */
export const HOME_TOURS_PHOTO_NOTE = 'На главной — туры со снимками; все туры — в каталоге.';

export interface PlateOrderInput {
  id: string;
  availability: CatalogAvailability;
  /** Главный кадр тура (tourHeroImageSql); нет снимка — на главную не берётся. */
  imageUrl: string | null;
  /** partners.id — компания; одна очередь и один билет жребия на компанию. */
  partnerId?: string | null;
  operatorName?: string | null;
  /** Ближайшая дата со свободными местами ('YYYY-MM-DD'); нет — null. */
  nearestFreeDate?: string | null;
}

/**
 * Туры витрины главной — правило 1в (слово владельца 29.10).
 *
 * Допуск: только туры со снимком. Главная — витрина снимков, и 29.10 первыми в
 * «Турах сезона» встали туры с серой заглушкой (у них не было сезона, у
 * остальных он кончился). Правило одно для всех компаний — это допуск, а не
 * поднятие; туры без снимка остаются в каталоге, на карточке места, у
 * Кузьмича и в MCP.
 *
 * Порядок: открытые туры, затем с кончившимся сезоном (`catalogAvailability`,
 * правило каталога, без своей копии порогов). В каждой части — группы по
 * компаниям (`groupOffersByCompany`: компания с ближайшей свободной датой
 * выше, ничьи — жребий дня компании, один билет на компанию, сколько бы туров
 * у неё ни было) и круг по компаниям (`roundRobinByCompany`): одна компания
 * не забирает витрину (жалоба владельца 08.10 «только рыбалка»). Новизна и
 * «с фото выше» в порядок не входят. Затем — не больше `PLATES_LIMIT`.
 *
 * Тур без компании — сам себе очередь.
 */
export function orderPlates<T extends PlateOrderInput>(plates: readonly T[], opts?: OfferOrderOptions): T[] {
  const day = opts?.day ?? offerOrderDay(opts?.now ?? new Date());
  const withPhoto = plates.filter((p) => typeof p.imageUrl === 'string' && p.imageUrl.trim() !== '');
  const turns = (part: readonly T[]): T[] => roundRobinByCompany(groupOffersByCompany(
    part.map((p) => ({
      plate: p,
      id: p.id,
      nearestFreeDate: p.nearestFreeDate ?? null,
      partnerId: p.partnerId?.trim() ? p.partnerId.trim() : `tour:${p.id}`,
      partnerName: p.operatorName ?? '',
    })),
    { day },
  )).map((x) => x.plate);
  const open = withPhoto.filter((p) => p.availability !== 'season_over');
  const closed = withPhoto.filter((p) => p.availability === 'season_over');
  return [...turns(open), ...turns(closed)].slice(0, PLATES_LIMIT);
}
