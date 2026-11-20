/**
 * Факты компактной карточки тура (каталог, 02.11): цена и длительность —
 * только из полей тура. Нет цены (null, пусто, 0, не число) → null, и карточка
 * пишет «Цена по запросу»; нет длительности → null, и плашки на фото нет.
 * Ничего не придумываем (§4.0): прежде `Number(null)` давал «0 ₽».
 */
import { plural } from '@/lib/home/data-freshness';
import { tourDurationDays } from '@/lib/bookings/duration';

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

/**
 * Длительность тура одной строкой — на карточке, в блоке туров места, в
 * каталоге, на главной, в сравнении и в MCP (#3487, 17.11).
 *
 * Правда длительности — записанные часы, если их меньше суток: тип `day` —
 * категория однодневного тура, а не вторая цифра. До 17.11 карточка начинала с
 * типа и у тура с `duration_type = 'day'` и `duration_hours = 3` писала
 * «1 день», а блок туров на карточке места — «3 ч». Порядок:
 *   1. бронь держит больше одного дня — «N дней» (ниже);
 *   2. многодневный тур на один день — «1 день»;
 *   3. часы записаны и меньше суток — «3 ч», «1,5 ч»;
 *   4. `half_day` — «Полдня», `day` — «1 день»;
 *   5. ровно сутки — «1 день».
 * Ничего не записано — null.
 *
 * Больше одного дня — число дней ПРАВИЛА БРОНИ (`tourDurationDays`,
 * lib/bookings/duration), при любом `duration_type` (20.11, слово владельца
 * «Исправить»). До этого тур с типом `day`, у которого записано пять дней,
 * карточка, get_tours, сравнение и fetch называли «1 день» или часами, а
 * бронь держала пять дней; часы от суток округлялись вниз (30 ч — «1 день»),
 * а бронь округляет вверх (2 дня). Подпись и бронь называют одно число.
 */
export function cardDuration(t: CardFactsInput): string | null {
  const h = t.duration_hours == null || t.duration_hours === '' ? NaN : Number(t.duration_hours);
  const hours = Number.isFinite(h) && h > 0 ? h : null;
  const count = t.multi_day_count == null ? NaN : Number(t.multi_day_count);
  const days = tourDurationDays({
    multi_day_count: Number.isInteger(count) ? count : null,
    duration_hours: hours,
  });
  if (days > 1) return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  if (t.duration_type === 'multi_day' && Number.isInteger(count) && count > 0) {
    return `${count} ${plural(count, 'день', 'дня', 'дней')}`;
  }
  if (hours !== null && hours < 24) {
    const shown = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10).replace('.', ',');
    return `${shown} ч`;
  }
  if (t.duration_type === 'half_day') return 'Полдня';
  if (t.duration_type === 'day') return '1 день';
  // Сюда доходят только ровно сутки: больше — дни правила брони выше.
  if (hours !== null) return '1 день';
  return null;
}

/**
 * Размер группы из колонки `max_participants` / `min_participants` (#3487).
 * Целое больше нуля — число; драйвер может отдать его строкой. Не записано или
 * не число — null: «до 20 человек» по умолчанию не подставляется (до 17.11
 * `/api/tours/[id]` отдавал 20 каждому туру — колонку читали под чужим именем,
 * а у тура «до 8 человек» это неправда).
 */
export function groupSizeOf(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}
