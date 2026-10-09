/**
 * lib/planner/day-price.ts — цена дня плана словами (#2304). Чистый модуль:
 * его читают экран /planner, PDF плана и страница /trip/<token>.
 *
 * Карточка дня писала «X — Y ₽ на человека» у любого тура. У четырёх туров
 * «Камчатской рыбалки» цена за группу, и 196 000 ₽ читались как цена с
 * каждого; у шести — за человека в день. Каталог эту единицу печатает
 * (`PRICE_UNIT_LABELS`, lib/tours/labels), план — нет.
 *
 * Здесь одна подпись на все три поверхности:
 *   — тур: цена оператора для этой группы с единицей, как в каталоге;
 *   — цены для группы нет (вне ступеней оператора) — так и сказано, без
 *     справочной вилки на её месте;
 *   — день без тура: ориентир на человека, и слово «ориентир» рядом;
 *   — день продолжения многодневного тура — без цены: она в первом дне.
 */
import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';

export interface DayPriceInput {
  priceFrom: number;
  priceTo: number;
  realPrice?: number;
  priceMissing?: string;
  realTour?: { priceUnit?: string; priceLabel?: string };
}

export type DayPrice =
  /** `main` — сумма, `unit` — за что она; `label` — почему цена не заголовочная. */
  | { kind: 'tour'; main: string; unit: string; label: string | null }
  | { kind: 'missing'; main: string; reason: string }
  | { kind: 'estimate'; main: string; unit: string }
  | { kind: 'none' };

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');

export function dayPrice(d: DayPriceInput): DayPrice {
  if (d.priceMissing) return { kind: 'missing', main: 'цену называет оператор', reason: d.priceMissing };
  if (d.realPrice && d.realPrice > 0) {
    const unit = d.realTour?.priceUnit;
    return {
      kind: 'tour', main: `${fmt(d.realPrice)} ₽`,
      // Незнакомая единица не превращается в «за человека» (priceFromUnit).
      unit: (unit && PRICE_UNIT_LABELS[unit]) || 'за что — не записано',
      label: d.realTour?.priceLabel ?? null,
    };
  }
  if (d.realTour) return { kind: 'none' };
  if (d.priceFrom > 0 || d.priceTo > 0) {
    return {
      kind: 'estimate',
      main: d.priceFrom === d.priceTo ? `${fmt(d.priceFrom)} ₽` : `${fmt(d.priceFrom)} — ${fmt(d.priceTo)} ₽`,
      unit: 'на человека, ориентир',
    };
  }
  return { kind: 'none' };
}

/** Одной строкой — для PDF и мест, где цена идёт в тексте. Пусто — цены нет. */
export function dayPriceLine(d: DayPriceInput): string {
  const p = dayPrice(d);
  if (p.kind === 'none') return '';
  if (p.kind === 'missing') return 'Цену для вашей группы называет оператор';
  return `${p.main} ${p.unit}${p.kind === 'tour' && p.label ? ` (${p.label})` : ''}`;
}
