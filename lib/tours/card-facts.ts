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

/**
 * Длительность тура одной строкой — на карточке, в блоке туров места, в
 * каталоге, на главной, в сравнении и в MCP (#3487, 17.11).
 *
 * Правда длительности — записанные часы, если их меньше суток: тип `day` —
 * категория однодневного тура, а не вторая цифра. До 17.11 карточка начинала с
 * типа и у тура с `duration_type = 'day'` и `duration_hours = 3` писала
 * «1 день», а блок туров на карточке места — «3 ч». Порядок:
 *   1. многодневный с числом дней — «N дней»;
 *   2. часы записаны и меньше суток — «3 ч», «1,5 ч»;
 *   3. `half_day` — «Полдня», `day` — «1 день»;
 *   4. часы от суток — дни округлением.
 * Ничего не записано — null.
 */
export function cardDuration(t: CardFactsInput): string | null {
  if (t.duration_type === 'multi_day' && t.multi_day_count && t.multi_day_count > 0) {
    const d = t.multi_day_count;
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  const h = t.duration_hours == null || t.duration_hours === '' ? NaN : Number(t.duration_hours);
  const hours = Number.isFinite(h) && h > 0 ? h : null;
  if (hours !== null && hours < 24) {
    const shown = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10).replace('.', ',');
    return `${shown} ч`;
  }
  if (t.duration_type === 'half_day') return 'Полдня';
  if (t.duration_type === 'day') return '1 день';
  if (hours !== null) {
    const d = Math.round(hours / 24);
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
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
