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

/** Порядок витрины: даты есть → даты по запросу → сезон кончился (в конец). */
export const AVAILABILITY_RANK: Record<CatalogAvailability, number> = { dates: 0, on_request: 1, season_over: 2 };

/**
 * Порядок туров на витрине главной. Тур с кончившимся сезоном не прячется, а
 * уходит в конец — иначе он занимал бы первую карточку на первом экране, куда
 * его ставит выборка по фото и свежести. Сортировка стабильная: внутри группы
 * остаётся порядок выборки. Затем — не больше `PLATES_LIMIT` карточек.
 * Сезон решает `catalogAvailability` (правило каталога), здесь только порядок.
 */
export function orderPlates<T extends { availability: CatalogAvailability }>(plates: readonly T[]): T[] {
  return plates
    .map((p, i) => ({ p, i }))
    .sort((a, b) => AVAILABILITY_RANK[a.p.availability] - AVAILABILITY_RANK[b.p.availability] || a.i - b.i)
    .slice(0, PLATES_LIMIT)
    .map(({ p }) => p);
}
