/**
 * lib/map/place-icon-raster.ts
 *
 * Мост между SVG-формой маркера места (lib/map/place-marker-icons.ts) и
 * растровым спрайтом, которого требует MapLibre GL для `icon-image`.
 *
 * Стиль (lib/map/vedar-style.ts) знает ИМЯ иконки заранее (строит его из
 * опасности и `kind` статическим выражением `icon-image`), но не может сам
 * нарисовать растр — он строится один раз, без доступа к DOM/canvas. Растр
 * собирается здесь, в браузере, по запросу MapLibre (`styleimagemissing`):
 * так каждая нужная комбинация цвет×форма рисуется РОВНО один раз за жизнь
 * карты, а не все формы × 2 цвета впрок, даже если на экране только вулканы.
 */

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
