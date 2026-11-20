/**
 * Копия снимка, обрезанная под плитку 4:3 (#3564 п.1, PageSpeed 20.11;
 * слово владельца «Делать копии 4:3»).
 *
 * Плитки главной показывают снимок в рамке 4:3 (`.plate .img`). У вертикального
 * кадра 640×853 рамка видит 480 строк из 853, а телефон качает весь файл —
 * водопад Опасный 92 КБ, гостиница «Кутха» 89 КБ. Сжать сильнее нельзя:
 * качество копии 640 уже 72. Экономит только копия, где уже нет того, что
 * рамка всё равно срежет (33 и 42 КБ).
 *
 * Обрезка повторяет то, что показывает рамка: `object-fit: cover` с точкой
 * кадра снимка (`photoFocusY`, lib/tours/photo-focus) по вертикали и серединой
 * по горизонтали. Точка — в имени копии (`.plate<точка>.webp`): поменяли
 * точку — нужна новая копия под новым именем. Под прежним именем менять байты
 * нельзя: `/images/*` кэшируется на год (immutable). Пока новой копии нет,
 * плитка берёт обычную копию 640, а не кадр со старой обрезкой.
 *
 * Здесь только правила без файлов; нарезку делает scripts/plate-crops.ts
 * (`npm run images`), список копий — lib/images/plate-crops.json.
 */

/** Ширина и высота копии: плитка до 360 css-пикселей при плотности 1,75. */
export const PLATE_WIDTH = 640;
export const PLATE_HEIGHT = 480;

/**
 * Рамка срезает меньше этой доли пикселей — копия не нужна: снимок почти
 * 4:3, и экономия меньше, чем лишний файл в хранилище.
 */
export const PLATE_MIN_LOSS = 0.15;

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Что из кадра W×H видит рамка 4:3 при `object-fit: cover` и
 * `object-position: 50% <fy>%`. Возвращает null, если кадр не выше рамки,
 * рамка срезает меньше PLATE_MIN_LOSS или кадр уже копии.
 */
export function plateCropBox(width: number, height: number, focusY: number): CropBox | null {
  if (!(width > 0 && height > 0) || width < PLATE_WIDTH) return null;
  const fy = Math.min(100, Math.max(0, focusY));
  const target = PLATE_WIDTH / PLATE_HEIGHT;
  // Только кадр выше рамки. У широкого копия 640 ниже рамки (640×360 у 16:9),
  // и копия 640×480 вышла бы тяжелее её — замер 20.11: 121 таких, 3,5 → 4,6 МБ.
  if (width / height >= target) return null;
  // Ширина целиком, сверху срезается по точке кадра.
  const h = Math.round(width / target);
  const box: CropBox = { left: 0, top: Math.round(((height - h) * fy) / 100), width, height: h };
  const loss = 1 - (box.width * box.height) / (width * height);
  return loss >= PLATE_MIN_LOSS ? box : null;
}

/** Адрес копии рядом с исходником: `x.jpg` → `x.plate55.webp`. */
export function plateCropPath(src: string, focusY: number): string {
  return src.replace(/\.(jpe?g|png)$/i, `.plate${Math.round(focusY)}.webp`);
}

/** Точка кадра, зашитая в имя копии; не копия — null. */
export function plateCropFocus(path: string): number | null {
  const m = /\.plate(\d{1,3})\.webp$/.exec(path);
  return m ? Number(m[1]) : null;
}
