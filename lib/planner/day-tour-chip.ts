/**
 * Тур в карточке дня планировщика (разбор планера 14.11, экран-2/12, смета-3).
 *
 * ── Что было ────────────────────────────────────────────────────────────
 *
 *   - у дня, на котором движок уже поставил тур, ссылка «оставить заявку»
 *     подбиралась заново по виду занятия и зоне — и вела на ДРУГОЙ тур: день
 *     назывался «Горелый», ссылка звала на «Авачинский»;
 *   - цена в ссылке стояла голым «от 48 000 ₽» — без «за группу», хотя смета
 *     тот же тур считала за группу;
 *   - тура в зоне дня нет — подставлялся тур из другой зоны, и ничего об этом
 *     не говорило.
 *
 * ── Правило ─────────────────────────────────────────────────────────────
 *
 * Тур в плане — он и есть тур дня (`planTourChip`); на дне продолжения
 * многодневного тура ссылки нет — она на первом дне. Цена — с единицей из
 * словаря каталога (`PRICE_UNIT_SHORT`), незнакомая единица названа
 * незаписанной. Тур не из зоны дня помечен.
 *
 * Сторож: tests/unit/planner-day-tour-chip.test.tsx.
 */
import { PRICE_UNIT_SHORT } from '@/lib/tours/labels';

export interface DayTourChip {
  id: string;
  /** Адрес карточки; null — ссылка по числу. */
  slug: string | null;
  title: string;
  base_price: string;
  price_unit: string | null;
  operator_slug: string;
  /** Тур не из зоны дня (в зоне подходящего нет). */
  other_zone?: boolean;
}

/** День плана в том объёме, что нужен ссылке. */
export interface ChipDay {
  type: string;
  title: string;
  realPrice?: number;
  priceMissing?: string;
  realTour?: { tourId: string; operatorSlug?: string; priceUnit?: string };
}

/**
 * Тур, который движок поставил на этот день; `null` — тура нет или это день
 * продолжения многодневного тура (цена и ссылка — на первом дне).
 */
export function planTourChip(day: ChipDay): DayTourChip | null {
  if (day.type !== 'activity' || !day.realTour) return null;
  if (!day.realPrice && !day.priceMissing) return null;
  return {
    id: day.realTour.tourId,
    slug: null,
    title: day.title,
    base_price: day.realPrice ? String(day.realPrice) : '',
    price_unit: day.realTour.priceUnit ?? null,
    operator_slug: day.realTour.operatorSlug ?? '',
  };
}

/** «от 48 000 ₽/группа»; единица не записана — сказано; цены нет — «цену называет оператор». */
export function dayTourPriceText(chip: Pick<DayTourChip, 'base_price' | 'price_unit'>): string {
  const n = Number(chip.base_price);
  if (!chip.base_price || !Number.isFinite(n) || n <= 0) return 'цену называет оператор';
  const sum = `от ${n.toLocaleString('ru-RU')} ₽`;
  const short = chip.price_unit ? PRICE_UNIT_SHORT[chip.price_unit] : undefined;
  return short ? `${sum}${short}` : `${sum}, за что — уточните`;
}
