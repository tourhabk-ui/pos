/**
 * Строка цены для чужих витрин: сумма ВМЕСТЕ с тем, за что она.
 *
 * Замер 30.09 (фиды Авито и Яндекса на проде): «Осенняя рыбалка» стоит
 * 25 000 ₽ за человека в день, «Семейный тур выходного дня» — 45 000 ₽ за
 * группу, а в обеих лентах лежали голые 25000 и 45000. На площадке их
 * сравнят как одно и то же, и турист, приехавший за «45 000 на семью по
 * цене 25 000 с человека», уйдёт с ощущением обмана — нашего, не оператора.
 *
 * Словарь единиц один — PRICE_UNIT_LABELS, им же говорит карточка тура.
 * Единица не записана — так и говорим, а не подставляем «за человека» (§4.0).
 */

import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';

/** «за человека» / «за группу» / «за чел./день»; null — единица не записана. */
export function priceUnitPhrase(unit: string | null | undefined): string | null {
  if (!unit) return null;
  return PRICE_UNIT_LABELS[unit] ?? null;
}

function rub(amount: number): string {
  return `${Math.round(amount).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`;
}

/** «Цена: 25 000 ₽ за чел./день.» — первая строка описания объявления. */
export function priceLine(amount: number, unit: string | null | undefined): string {
  const phrase = priceUnitPhrase(unit);
  return phrase
    ? `Цена: ${rub(amount)} ${phrase}.`
    : `Цена: ${rub(amount)} — за человека или за группу, уточните у оператора.`;
}
