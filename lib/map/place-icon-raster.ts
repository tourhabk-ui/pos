/**
 * lib/map/place-icon-raster.ts
 *
 * Мост между SVG-формой маркера места (lib/map/place-marker-icons.ts) и
 * растровым спрайтом, которого требует MapLibre GL для `icon-image`.
 *
 * Стиль (lib/map/vedar-style.ts) знает ИМЯ иконки заранее (строит его из
 * опасности и `kind` статическим выражением `icon-image`), но не может сам
 * нарисовать растр — он строится один раз, без доступа к DOM/canvas. Растр
 * собирается здесь, в браузере, по запросу MapLibre (резолвер недостающих
 * картинок, см. placeIconResolver): так каждая нужная комбинация цвет×форма
 * рисуется РОВНО один раз за жизнь карты, а не все формы × 2 цвета впрок,
 * даже если на экране только вулканы.
 */

import { PLACE_KIND_COLOR } from './place-marker-icons';

export const PLACE_ICON_PIXEL_RATIO = 2;

/** Префикс+состав имени иконки — общий словарь между стилем и растеризатором. */
const PREFIX = 'place-icon-';

/** Имя иконки в спрайте карты — та же формула, что зовёт `icon-image` в стиле. */
export function placeIconImageId(hazardous: boolean, kind: string): string {
  return `${PREFIX}${hazardous ? 'hazard' : 'normal'}-${kind}`;
}

/** Разбирает имя иконки обратно на опасность и вид — для styleimagemissing. */
export function parsePlaceIconImageId(id: string): { hazardous: boolean; kind: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  if (rest.startsWith('hazard-')) return { hazardous: true, kind: rest.slice('hazard-'.length) };
  if (rest.startsWith('normal-')) return { hazardous: false, kind: rest.slice('normal-'.length) };
  return null;
}

/**
 * Растеризует SVG-разметку в пиксели под `PLACE_ICON_PIXEL_RATIO` — тот же
 * визуальный размер (24×28 CSS-px), что был у Leaflet divIcon, но резкий на
 * retina-экранах (владелец постоянно смотрит с телефона).
 *
 * `Image.src` через некодированный `data:image/svg+xml` — без base64: короче
 * и не требует UTF-8-эквилибристики вокруг `btoa` для кириллицы в подписях,
 * которой в этих SVG, впрочем, нет, но появиться может.
 */
export function rasterizePlaceIcon(
  svg: string,
  widthCss: number,
  heightCss: number,
  pixelRatio: number = PLACE_ICON_PIXEL_RATIO,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = Math.round(widthCss * pixelRatio);
      const height = Math.round(heightCss * pixelRatio);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas 2d недоступен')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      let imageData: ImageData;
      try {
        imageData = ctx.getImageData(0, 0, width, height);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve({ width, height, data: imageData.data });
    };
    img.onerror = () => reject(new Error('иконка места: SVG не decode'));
    img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  });
}

export type PlaceIconRaster = { width: number; height: number; data: Uint8ClampedArray };

/**
 * Цвета иконки места. Заливка — по КАТЕГОРИИ (владелец 10.09: «разделять
 * цветами по фильтрам»), один источник на обе карты (PLACE_KIND_COLOR).
 * Опасность (`hazard_types` не пуст) красит не заливку, а КРОМКУ — иначе
 * вулкан с записанным профилем терял бы свой цвет и становился неотличим от
 * источника. Некритичная кромка — фон карты (контраст с любой ступенью
 * гипсометрии, владелец 07.09), опасная — цвет тревоги, тот же, что у обрыва.
 */
export function placeIconColors(
  icon: { hazardous: boolean; kind: string },
  palette: { cliff: string; background: string },
): { fill: string; halo: string } {
  return {
    fill: PLACE_KIND_COLOR[icon.kind] ?? PLACE_KIND_COLOR.other,
    halo: icon.hazardous ? palette.cliff : palette.background,
  };
}

/** Сколько MapLibre ждёт растр иконки, прежде чем разложить тайл без неё. */
export const PLACE_ICON_TIMEOUT_MS = 3000;

/** Что резолверу нужно от карты. Карта MapLibre подходит как есть. */
export interface PlaceIconSink {
  hasImage(id: string): boolean;
  addImage(id: string, image: PlaceIconRaster, options: { pixelRatio: number }): unknown;
}

/**
 * Резолвер недостающих иконок мест — `map.setMissingStyleImageResolver` (14.10).
 *
 * До этого иконку собирал обработчик события `styleimagemissing`, и под
 * MapLibre 6 это перестало работать так, как задумано: событие теперь
 * приходит ПОСЛЕ того, как картинка объявлена недостающей, и слушатель не
 * может дать её текущему запросу. На проде (map-page-check, прогон 22) каждое
 * открытие /map печатало 40 предупреждений «Image … could not be loaded»:
 * тайлы мест раскладывались без значков, а когда растры доезжали — второй
 * раз. Стенд в контейнере разработки (MapLibre 6.11.2, 382 точки, 40 иконок):
 * загрузок тайлов мест 16 против 12, предупреждений 40 против 0.
 *
 * MapLibre ждёт обещание резолвера, прежде чем считать картинку недостающей,
 * — значки ложатся в первую же раскладку. Ждёт не дольше `timeoutMs`:
 * зависший растр не должен держать слой мест пустым. Не успевший растр
 * ложится в спрайт позже, и MapLibre перерисует тайлы сам; отказ — в лог с
 * именем иконки (§4.0), обещание при этом не отклоняется.
 *
 * Чужое имя (не `place-icon-…`) и уже добавленная картинка — не работа
 * резолвера: он возвращает undefined, и MapLibre решает сам.
 */
export function placeIconResolver(
  sink: PlaceIconSink,
  draw: (icon: { hazardous: boolean; kind: string }) => Promise<PlaceIconRaster>,
  opts: {
    timeoutMs?: number;
    /** Карта снята (эффект пересоздал её) — поздний растр в неё не кладётся. */
    isCancelled?: () => boolean;
    onError?: (id: string, err: unknown) => void;
  } = {},
): (id: string) => Promise<void> | undefined {
  const timeoutMs = opts.timeoutMs ?? PLACE_ICON_TIMEOUT_MS;
  const pending = new Map<string, Promise<void>>();
  return (id) => {
    if (sink.hasImage(id)) return undefined;
    const icon = parsePlaceIconImageId(id);
    if (!icon) return undefined;
    const known = pending.get(id);
    if (known) return known;
    const job = new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => {
        if (settled) return;
        opts.onError?.(id, new Error(`растр не успел за ${timeoutMs} мс — тайл разложен без значка`));
        settle();
      }, timeoutMs);
      draw(icon)
        .then((img) => {
          if (opts.isCancelled?.() || sink.hasImage(id)) return;
          sink.addImage(id, img, { pixelRatio: PLACE_ICON_PIXEL_RATIO });
        })
        .catch((err: unknown) => opts.onError?.(id, err))
        .finally(() => { clearTimeout(timer); settle(); });
    });
    pending.set(id, job);
    return job;
  };
}
