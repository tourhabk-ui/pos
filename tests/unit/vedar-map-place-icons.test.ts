/**
 * VedarMap — форма маркера места собирается по запросу MapLibre.
 *
 * Владелец 07.09: «геоточки были все со своими маркерами». Стиль (§ форма и
 * цвет мест, lib/map/vedar-style.ts) лишь называет иконку строкой — растр
 * собирает сам компонент, когда MapLibre её впервые просит.
 *
 * 14.10: под MapLibre 6 событие styleimagemissing приходит, когда тайл уже
 * разложен без значка, — на каждом открытии /map 40 предупреждений «Image …
 * could not be loaded» и вторая раскладка мест (map-page-check, прогон 22).
 * Растр теперь отдаёт резолвер (`setMissingStyleImageResolver`), которого
 * MapLibre ждёт до раскладки. Сторож — вызовом (правило 13.10): резолвер и
 * цвета — функции на граничных данных; из исходника VedarMap судится только
 * подключение и запрет вернуться к событию.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  placeIconColors, placeIconResolver, placeIconImageId, PLACE_ICON_PIXEL_RATIO, PLACE_ICON_TIMEOUT_MS,
  type PlaceIconRaster,
} from '@/lib/map/place-icon-raster';
import { PLACE_KIND_COLOR } from '@/lib/map/place-marker-icons';

const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

const raster = (tag: number): PlaceIconRaster => ({ width: 48, height: 56, data: new Uint8ClampedArray([tag]) });

/** Карта-двойник: только то, что резолвер у неё спрашивает. */
function fakeSink() {
  const images = new Map<string, { image: PlaceIconRaster; pixelRatio: number }>();
  return {
    images,
    hasImage: (id: string) => images.has(id),
    addImage: vi.fn((id: string, image: PlaceIconRaster, options: { pixelRatio: number }) => {
      images.set(id, { image, pixelRatio: options.pixelRatio });
    }),
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('placeIconResolver — растр значка до раскладки тайла', () => {
  it('своё имя: рисует разобранный значок и кладёт его в спрайт ДО того, как отпускает MapLibre', async () => {
    const sink = fakeSink();
    const draw = vi.fn(async () => raster(1));
    const resolve = placeIconResolver(sink, draw);
    const id = placeIconImageId(true, 'volcano');
    const pending = resolve(id);
    expect(pending).toBeInstanceOf(Promise);
    expect(draw).toHaveBeenCalledWith({ hazardous: true, kind: 'volcano' });
    await pending;
    // MapLibre смотрит в спрайт сразу после обещания — значок уже там.
    expect(sink.images.get(id)).toEqual({ image: raster(1), pixelRatio: PLACE_ICON_PIXEL_RATIO });
  });

  it('чужое имя и уже добавленный значок — не работа резолвера: undefined, ничего не рисуется', () => {
    const sink = fakeSink();
    const draw = vi.fn(async () => raster(1));
    const resolve = placeIconResolver(sink, draw);
    expect(resolve('osm-spring-icon')).toBeUndefined();
    sink.images.set('place-icon-normal-lake', { image: raster(0), pixelRatio: 2 });
    expect(resolve('place-icon-normal-lake')).toBeUndefined();
    expect(draw).not.toHaveBeenCalled();
  });

  it('один значок из многих тайлов разом — один растр и одно общее обещание', async () => {
    const sink = fakeSink();
    const draw = vi.fn(async () => raster(2));
    const resolve = placeIconResolver(sink, draw);
    const a = resolve('place-icon-normal-bay');
    const b = resolve('place-icon-normal-bay');
    expect(b).toBe(a);
    await a;
    expect(draw).toHaveBeenCalledTimes(1);
    expect(sink.addImage).toHaveBeenCalledTimes(1);
  });

  it('растр не собрался — в лог с именем значка, обещание не отклоняется (MapLibre разложит без значка)', async () => {
    const sink = fakeSink();
    const onError = vi.fn();
    const resolve = placeIconResolver(sink, async () => { throw new Error('SVG не decode'); }, { onError });
    await expect(resolve('place-icon-hazard-geyser')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('place-icon-hazard-geyser', expect.objectContaining({ message: 'SVG не decode' }));
    expect(sink.addImage).not.toHaveBeenCalled();
  });

  it('спрайт отказал — тоже в лог, а не необработанным отказом', async () => {
    const sink = fakeSink();
    sink.addImage.mockImplementation(() => { throw new Error('стиль снят'); });
    const onError = vi.fn();
    const resolve = placeIconResolver(sink, async () => raster(3), { onError });
    await expect(resolve('place-icon-normal-river')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('place-icon-normal-river', expect.objectContaining({ message: 'стиль снят' }));
  });

  it('зависший растр держит раскладку не дольше срока; поздний всё равно ложится в спрайт', async () => {
    vi.useFakeTimers();
    const sink = fakeSink();
    const onError = vi.fn();
    let finish: (r: PlaceIconRaster) => void = () => {};
    const resolve = placeIconResolver(sink, () => new Promise((r) => { finish = r; }), { onError });
    let released = false;
    void resolve('place-icon-normal-cave')?.then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(PLACE_ICON_TIMEOUT_MS - 1);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(onError).toHaveBeenCalledWith('place-icon-normal-cave', expect.objectContaining({ message: expect.stringContaining(`${PLACE_ICON_TIMEOUT_MS} мс`) }));
    finish(raster(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.images.get('place-icon-normal-cave')?.image).toEqual(raster(4));
  });

  it('карта снята, пока растр ехал, — в неё ничего не кладётся', async () => {
    const sink = fakeSink();
    let cancelled = false;
    let finish: (r: PlaceIconRaster) => void = () => {};
    const resolve = placeIconResolver(sink, () => new Promise((r) => { finish = r; }), { isCancelled: () => cancelled });
    const pending = resolve('place-icon-normal-pass');
    cancelled = true;
    finish(raster(5));
    await pending;
    expect(sink.addImage).not.toHaveBeenCalled();
  });
});

describe('placeIconColors — заливка по категории, кромка по опасности', () => {
  const palette = { cliff: '#B00020', background: '#F5F0EB' };

  it('заливка — цвет категории места (владелец 10.09), неизвестная категория — «прочее»', () => {
    expect(placeIconColors({ hazardous: false, kind: 'volcano' }, palette).fill).toBe(PLACE_KIND_COLOR.volcano);
    expect(placeIconColors({ hazardous: true, kind: 'volcano' }, palette).fill).toBe(PLACE_KIND_COLOR.volcano);
    expect(placeIconColors({ hazardous: false, kind: 'новый-род' }, palette).fill).toBe(PLACE_KIND_COLOR.other);
  });

  it('кромка — фон карты в норме, цвет тревоги у опасных мест', () => {
    expect(placeIconColors({ hazardous: false, kind: 'lake' }, palette).halo).toBe(palette.background);
    expect(placeIconColors({ hazardous: true, kind: 'lake' }, palette).halo).toBe(palette.cliff);
  });
});

describe('VedarMap подключает резолвер', () => {
  it('резолвер стоит на карте; цвета — из палитры темы этого инстанса', () => {
    expect(MAP).toMatch(/map\.setMissingStyleImageResolver\(placeIconResolver\(\s*map,/);
    expect(MAP).toMatch(/placeIconColors\(icon, palette\)/);
    // palette собран из ТОГО ЖЕ theme, которым строится style этого инстанса.
    expect(MAP).toMatch(/const palette = vedarMapPalette\(theme\);/);
    // Отказ растра — в лог с именем значка.
    expect(MAP).toMatch(/onError: \(id, err\) => console\.error\('\[VedarMap\] иконка места не собралась', id, err\)/);
  });

  it('к событию styleimagemissing не возвращаемся: под MapLibre 6 оно не успевает к раскладке', () => {
    expect(MAP).not.toMatch(/on\(\s*'styleimagemissing'/);
  });
});
