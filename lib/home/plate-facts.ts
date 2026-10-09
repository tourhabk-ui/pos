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
import { tourPath } from '@/lib/tours/tour-url';
import { plural } from '@/lib/home/data-freshness';
import type { CatalogAvailability } from '@/lib/tours/catalog-availability';

export interface PlateFactsInput {
  /** 'transfer' — вахтовка под заказ: цена называется за МАШИНУ, а не за человека. */
  kind?: string;
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
    // У трансфера под заказ единица одна и называется прямо: умолчание
    // «/чел.» превратило бы 65 000 ₽ за вахтовку в 65 000 ₽ с человека.
    price: p.kind === 'transfer'
      ? priceFrom(p.priceFrom, '₽ за машину')
      : priceFrom(p.priceFrom, `₽ ${priceUnitLabel(p.priceUnit, true)}`),
    duration: plateDuration(p),
    operator,
  };
}

/**
 * Адрес карточки ленты: тур — своя страница, трансфер под заказ — экран
 * /transfers (карточка перевозчика с прайсом), остальное — маршрут. Один
 * ответ на оба дерева главной: две копии условия разошлись бы.
 */
export function plateHref(p: { kind: string; id: string; slug: string | null }): string {
  if (p.kind === 'transfer') return '/transfers';
  if (p.kind === 'tour') return tourPath(p);
  return `/routes/${p.id}`;
}

/** Место трансфера в ленте: третьим, чтобы он был виден до конца первой прокрутки. */
export const TRANSFER_PLATE_POSITION = 2;

/**
 * Вставляет карточку трансфера в ленту туров. Нет туров — не вставляет: лента
 * из одной вахтовки под заголовком «Туры сезона» была бы обманом. Потолок
 * витрины остаётся прежним: вставка вытесняет последний тур, а не растит ленту.
 * Нет карточки (перевозчиков под заказ нет или не смогли прочитать) — лента
 * как была.
 */
export function withTransferPlate<T>(plates: readonly T[], transfer: T | null): T[] {
  if (!transfer || plates.length === 0) return [...plates];
  const at = Math.min(TRANSFER_PLATE_POSITION, plates.length);
  return [...plates.slice(0, at), transfer, ...plates.slice(at)].slice(0, PLATES_LIMIT);
}

/** Сколько туров помещается на витрину главной. */
export const PLATES_LIMIT = 8;

/** Порядок витрины: даты есть → даты по запросу → сезон кончился (в конец). */
export const AVAILABILITY_RANK: Record<CatalogAvailability, number> = { dates: 0, on_request: 1, season_over: 2 };

/**
 * Порядок туров на витрине главной. Тур с кончившимся сезоном не прячется, а
 * уходит в конец — иначе он занимал бы первую карточку на первом экране, куда
 * его ставит выборка по фото и свежести. Сезон решает `catalogAvailability`
 * (правило каталога), здесь только порядок. Затем — не больше `PLATES_LIMIT`.
 *
 * Внутри открытых туров операторы идут по очереди (08.10, жалоба владельца
 * «в ленте на главной только рыбалка»). Строгое «даты → по запросу» отдавало
 * все восемь мест одному оператору: у рыбалки девять туров с датами, у «Края
 * Вулканов» одиннадцать туров с датами по запросу — и ни один из них на
 * витрину не попадал. Теперь у каждого оператора своя очередь в прежнем
 * порядке (даты → по запросу → выборка), а операторы встают в круг в порядке
 * своего лучшего тура. Тур без имени оператора — сам себе очередь.
 */
export function orderPlates<T extends { availability: CatalogAvailability; operatorName?: string | null }>(
  plates: readonly T[],
): T[] {
  const ranked = plates
    .map((p, i) => ({ p, i }))
    .sort((a, b) => AVAILABILITY_RANK[a.p.availability] - AVAILABILITY_RANK[b.p.availability] || a.i - b.i);
  const open = ranked.filter(({ p }) => p.availability !== 'season_over');
  const closed = ranked.filter(({ p }) => p.availability === 'season_over');
  return [...byOperatorTurns(open), ...byOperatorTurns(closed)].slice(0, PLATES_LIMIT);
}

/** Круг по операторам: первый тур каждого, затем второй каждого и так далее. */
function byOperatorTurns<T extends { operatorName?: string | null }>(items: readonly { p: T; i: number }[]): T[] {
  const queues = new Map<string, T[]>();
  for (const { p, i } of items) {
    const name = p.operatorName?.trim();
    const key = name ? `op:${name}` : `tour:${i}`;
    const q = queues.get(key);
    if (q) q.push(p);
    else queues.set(key, [p]);
  }
  const out: T[] = [];
  const lists = [...queues.values()];
  for (let turn = 0; out.length < items.length; turn++) {
    for (const q of lists) if (turn < q.length) out.push(q[turn]);
  }
  return out;
}
