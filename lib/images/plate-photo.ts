/**
 * Копия снимка под рамку плитки 4:3 (#3564 п.1, слово владельца «Делать
 * копии 4:3»). Правила обрезки — lib/images/plate-crop.ts, нарезка —
 * scripts/plate-crops.ts, список — lib/images/plate-crops.json.
 *
 * Копия отдаётся, только если точка кадра в её имени равна сегодняшней точке
 * снимка (`photoFocusY`). Точку поправили, а копию ещё не перерезали — плитка
 * берёт обычную копию 640 и режет её сама по новой точке, а не показывает
 * старую обрезку.
 */
import crops from './plate-crops.json';
import { plateCropFocus } from './plate-crop';
import { photoFocusY } from '@/lib/tours/photo-focus';

const PLATE_CROPS: Readonly<Record<string, string>> = crops as Record<string, string>;

export function platePhotoSrc(src: string | null | undefined): string | null {
  if (!src || !Object.prototype.hasOwnProperty.call(PLATE_CROPS, src)) return null;
  const crop = PLATE_CROPS[src];
  if (!crop || plateCropFocus(crop) !== (photoFocusY(src) ?? 0)) return null;
  return crop;
}
