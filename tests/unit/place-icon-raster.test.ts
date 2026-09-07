/**
 * lib/map/place-icon-raster.ts — имя иконки в спрайте карты и растеризация
 * по запросу (styleimagemissing).
 *
 * Имя, которое строит стиль (lib/map/vedar-style.ts, `icon-image`), и имя,
 * которое разбирает VedarMap при получении styleimagemissing, обязаны быть
 * ОБРАТНЫМИ операциями друг друга — иначе иконка навсегда останется «не
 * пришла», и это не будет видно нигде, кроме как глазами в поле.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  placeIconImageId, parsePlaceIconImageId, rasterizePlaceIcon, PLACE_ICON_PIXEL_RATIO,
} from '@/lib/map/place-icon-raster';

describe('placeIconImageId / parsePlaceIconImageId — обратные операции', () => {
  it('опасное место — префикс hazard', () => {
    expect(placeIconImageId(true, 'volcano')).toBe('place-icon-hazard-volcano');
  });

  it('обычное место — префикс normal', () => {
    expect(placeIconImageId(false, 'lake')).toBe('place-icon-normal-lake');
  });

  it('разбор строит то же самое, что сборка', () => {
    for (const hazardous of [true, false]) {
      for (const kind of ['volcano', 'hot_spring', 'other', 'какой-то-новый-тип']) {
        const id = placeIconImageId(hazardous, kind);
        expect(parsePlaceIconImageId(id)).toEqual({ hazardous, kind });
      }
    }
  });

  it('чужое имя (не из нашего спрайта) — null, не угадывание', () => {
    expect(parsePlaceIconImageId('osm-spring-icon')).toBeNull();
    expect(parsePlaceIconImageId('place-icon-unknown-volcano')).toBeNull();
  });
});

describe('rasterizePlaceIcon — растр под текущий pixelRatio', () => {
  const realImage = globalThis.Image;
  const realCreateElement = document.createElement.bind(document);

  afterEach(() => {
    globalThis.Image = realImage;
    vi.restoreAllMocks();
  });

  it('размер растра — CSS-размер × pixelRatio', async () => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    // @ts-expect-error — тестовый двойник Image, не полный DOM-интерфейс
    globalThis.Image = FakeImage;

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return realCreateElement(tag);
      const data = new Uint8ClampedArray(4);
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({ data, width: w, height: h }),
        }),
      } as unknown as HTMLCanvasElement;
    });

    const result = await rasterizePlaceIcon('<svg></svg>', 24, 28, PLACE_ICON_PIXEL_RATIO);
    expect(result.width).toBe(24 * PLACE_ICON_PIXEL_RATIO);
    expect(result.height).toBe(28 * PLACE_ICON_PIXEL_RATIO);
  });

  it('SVG, который browser не смог decode — честный отказ, не зависшее обещание', async () => {
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    // @ts-expect-error — тестовый двойник
    globalThis.Image = FailingImage;

    await expect(rasterizePlaceIcon('не svg вовсе', 24, 28)).rejects.toThrow();
  });
});
