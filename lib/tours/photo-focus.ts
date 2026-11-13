/**
 * Точка кадрирования фото туров для `object-cover` в ШИРОКИХ кадрах —
 * плитки каталога (16:10), плитки на странице оператора и сайте партнёра,
 * /hub/fishing, плитки главной, миниатюры помощника.
 *
 * Фото операторов в основном портретные (960×1280): рыбак с уловом во весь
 * рост. `object-cover` по умолчанию показывает вертикальную середину — то есть
 * туловище и рыбу без головы (замечание владельца 29.09).
 *
 * 30.09 владелец снова: «почему голова Толика обрезана» — карточка каталога.
 * Точка `50% 30%` была взята у героя карточки тура, а там кадр ВЫСОКИЙ
 * (до 64vh на телефоне) и почти ничего не срезает. В плитке 4:3 портрет 3:4
 * видно лишь на 56% его высоты, и при 30% сверху уходило 13% кадра — ровно
 * голова. Верх кадра (`50% 0%`) держит полосу 0–56%: голова целиком, рыба в
 * руках (у кадра Толика — до ~45% высоты) тоже. Пейзажи и фото шире плитки
 * от вертикальной точки не зависят вовсе.
 *
 * 12.11 владелец: «и на десктопной тоже небо вместо локаций». Верх кадра —
 * правильный ответ для человека во весь рост и неправильный для пейзажа,
 * снятого вертикально: у «Мыса Маячного» верхние 45% кадра — чистое небо, и
 * плитка 16:10 (видно 47% высоты портрета 3:4) показывала только его. Одна
 * точка на все фото не может быть верной сразу для обоих родов. Поэтому точка
 * теперь принадлежит СНИМКУ: `PHOTO_FOCUS_Y` ниже — проверенные глазами
 * портретные пейзажи главных кадров живых туров; кадр не из списка остаётся
 * на верхе кадра, и голова рыбака по-прежнему цела.
 *
 * Точка привязана к адресу фото, а не к туру: оператор сменил обложку — новая
 * фотография не унаследует чужую точку и встанет на верх кадра, пока её не
 * посмотрят. Ключ — путь снимка в хранилище без расширения и без суффикса
 * нарезки (`.640.webp`), чтобы один снимок узнавался во всех своих адресах.
 *
 * 12.11, вдогонку («карт-бланш»): список руками лечит только просмотренные
 * снимки, и новая вертикальная обложка снова показала бы небо. Поэтому у
 * каждого портретного снимка в хранилище точку считает станок
 * (`scripts/photo-focus.mjs`, входит в `npm run images`): где в кадре
 * кончается ровное небо и начинаются детали. Файл —
 * `lib/images/photo-focus.json`. Порядок: ручная точка, затем посчитанная,
 * затем верх кадра. Снимок, загруженный оператором в рантайме, станок не
 * видел — он стоит на верхе кадра.
 *
 * Герой карточки тура остаётся на своих `50% 30%` — у него другой кадр.
 */
import autoFocus from '@/lib/images/photo-focus.json';

export const TOUR_PHOTO_POSITION = '50% 0%';

/** Точки, посчитанные станком по самим снимкам. */
export const AUTO_PHOTO_FOCUS_Y: Readonly<Record<string, number>> = autoFocus as Record<string, number>;

/**
 * Вертикальная точка (0 — верх, 100 — низ) у портретных пейзажей, проверенная
 * на обрезке 16:10 12.11. Значение — где у снимка предмет съёмки: вулкан,
 * бухта, каньон. Сюда не вносят портреты людей — им нужен верх кадра.
 * Главнее посчитанной: глаз видит предмет, станок — только начало деталей
 * (у каньона это хребет над ним, а не водопад внизу).
 * Сторож: tests/unit/tour-photo-focus.test.ts (снимок существует в
 * media/s3/photos, он портретный, точка в 0..100).
 */
export const PHOTO_FOCUS_Y: Readonly<Record<string, number>> = {
  // Бухта, Три брата и Вилючинский; верх кадра — небо (жалоба 12.11).
  'laguna-expedition/mys-mayachnyj-cover': 70,
  // Снежный хребет за деревьями; верх кадра — ветки на фоне неба (жалоба 12.11).
  'laguna-expedition/chasovaya-progulka-cover': 65,
  // Каньон с водопадом внизу кадра, хребет над ним.
  'laguna-expedition/kanon-opasnyj-cover': 65,
  // Вулкан в окне вертолёта; верх кадра — тёмная рама окна.
  'laguna-expedition/obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya-cover': 40,
  // Купель и деревья; верх кадра — небо.
  'laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-cover': 60,
  // Парящий бассейн и вулкан вдали; верх кадра — небо.
  'laguna-expedition/novogodnie-vulkany-kamchatki-laguna-4-cover': 60,
  // Озеро в долине и группа на склоне.
  'mestechko/vachkazhets-01': 45,
  // Водопад в каньоне и снежный хребет.
  'zaporozhets/opasny-canyon-waterfall': 55,
  // Толбачик и дорога; низ кадра — капот машины.
  'zaporozhets/tolbachik-plosky-view': 30,
};

/** Ключ снимка: путь в хранилище без расширения и суффикса нарезки. */
export function photoFocusKey(src: string | null | undefined): string | null {
  if (!src) return null;
  let path = src.trim();
  if (!path) return null;
  path = path.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
  path = path.replace(/^\/api\/images\/s3\/photos\//, '').replace(/^\/images\//, '').replace(/^\//, '');
  path = path.replace(/\.(320|640|1280)\.webp$/i, '').replace(/\.(jpe?g|png|webp)$/i, '');
  return path || null;
}

function own(table: Readonly<Record<string, number>>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const y = table[key];
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  return Math.min(100, Math.max(0, Math.round(y)));
}

/**
 * Точка снимка: ручная, иначе посчитанная станком, иначе `null` (верх кадра).
 */
export function photoFocusY(src: string | null | undefined): number | null {
  const key = photoFocusKey(src);
  if (!key) return null;
  return own(PHOTO_FOCUS_Y, key) ?? own(AUTO_PHOTO_FOCUS_Y, key);
}

/**
 * Точка кадрирования фото тура для широкой плитки: точка снимка (ручная или
 * посчитанная), иначе верх кадра (`TOUR_PHOTO_POSITION`).
 */
export function tourPhotoPosition(src: string | null | undefined): string {
  const y = photoFocusY(src);
  return y == null ? TOUR_PHOTO_POSITION : `50% ${y}%`;
}
