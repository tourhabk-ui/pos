/**
 * lib/home/stay-plate.ts — карточка жилья в ленте туров главной (решение
 * владельца 10.10: «нужно добавить в ленту, где туры и трансферы»).
 *
 * Тур — что посмотреть, трансфер — как добраться, жильё — где ночевать.
 * Карточка ведёт на страницу объекта, где фото, цены и заявка хозяину.
 *
 * Честность та же, что у трансфера: цена — «от» нижней записанной цены за
 * сутки, без цены карточки нет (объект «цена у владельца» в ленту продаж не
 * встаёт), без фото — тоже: лента из снимков, пустая плашка в ней выглядит
 * поломкой. Порядок в ленте: тур, тур, трансфер, тур, тур, жильё.
 *
 * Модуль без базы — его читают и сервер, и клиент главной.
 * Сторож: tests/unit/home-stay-plate.test.ts.
 */

import { formatRub } from '@/lib/transfers/charter-format';

export interface StayPlate {
  kind: 'stay';
  id: string;
  title: string;
  /** Короткое описание объекта; null — не записано. */
  caption: string | null;
  /** «от 24 000 ₽ за сутки». */
  price: string;
  /** Адрес или посёлок; null — не записан. */
  place: string | null;
  imageUrl: string;
  href: string;
}

export interface StayPlateRow {
  id: string;
  name: string;
  short_description: string | null;
  address: string | null;
  price_from: number | string | null;
  image_url: string | null;
}

export function toStayPlate(r: StayPlateRow): StayPlate | null {
  const price = r.price_from == null ? NaN : Number(r.price_from);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!r.image_url) return null;
  return {
    kind: 'stay',
    id: `stay-${r.id}`,
    title: r.name,
    caption: r.short_description?.trim() || null,
    price: `от ${formatRub(price)} за сутки`,
    place: r.address?.trim() || null,
    imageUrl: r.image_url,
    href: `/accommodations/${r.id}`,
  };
}

/**
 * Встать в ленту после второго тура за трансфером — пятой карточкой; если
 * карточек меньше — в конец. Без туров жилью в ленте туров не место.
 */
export function withStayPlate<T>(cards: readonly T[], stay: StayPlate | null, hasTours: boolean): Array<T | StayPlate> {
  if (!stay || !hasTours) return [...cards];
  const at = Math.min(5, cards.length);
  return [...cards.slice(0, at), stay, ...cards.slice(at)];
}

export function isStayPlate(x: unknown): x is StayPlate {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'stay';
}
