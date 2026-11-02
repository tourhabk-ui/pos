/**
 * Факты компактной карточки тура (каталог, 02.11): цена и длительность —
 * только из полей тура. Нет цены (null, пусто, 0, не число) → null, и карточка
 * пишет «Цена по запросу»; нет длительности → null, и плашки на фото нет.
 * Ничего не придумываем (§4.0): прежде `Number(null)` давал «0 ₽».
 */
import { plural } from '@/lib/home/data-freshness';

export interface CardFactsInput {
  base_price?: string | number | null;
  duration_type?: string | null;
  multi_day_count?: number | null;
  duration_hours?: string | number | null;
}

export function cardPrice(t: CardFactsInput): number | null {
  if (t.base_price == null || t.base_price === '') return null;
  const n = Number(t.base_price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cardDuration(t: CardFactsInput): string | null {
  if (t.duration_type === 'multi_day' && t.multi_day_count && t.multi_day_count > 0) {
    const d = t.multi_day_count;
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  if (t.duration_type === 'half_day') return 'Полдня';
  if (t.duration_type === 'day') return '1 день';
  if (t.duration_hours != null && t.duration_hours !== '') {
    const h = Number(t.duration_hours);
    if (!Number.isFinite(h) || h <= 0) return null;
    if (h < 24) return `${h} ч`;
    const d = Math.round(h / 24);
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  return null;
}
