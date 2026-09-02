/**
 * Гипсометрия своей карты (02.09, слово владельца «мне нужна качественно
 * прорисованная карта»).
 *
 * До этого рельеф был одноцветным — только тень склонов; море от суши не
 * отличалось. Слой `color-relief` MapLibre (с 5.7, у нас 6.6) красит высоту
 * из ТОГО ЖЕ terrain-RGB, что и тень: ни нового файла, ни пересборки
 * пакета. Первая ступень — море: Copernicus DEM держит 0 над водой.
 *
 * Черты:
 *  1. Слой есть в обеих темах, под заливками и тенью; стиль валиден.
 *  2. Ступени идут по возрастанию высоты и начинаются с моря.
 *  3. Соседний район получает гипсометрию в базовом ярусе — обзор
 *     соседей без цвета высоты был бы плоским пятном.
 *  4. Тень поверх цвета слабее, чем была поверх плоского фона, и на обзоре
 *     слабее, чем вблизи.
 */
import { describe, it, expect } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { buildVedarStyle, buildRegionOverlay } from '@/lib/map/vedar-style';

const base = 'https://s3.example.ru/b';
const src = {
  terrainUrl: `pmtiles://${base}/map-packs/avacha-group.terrain.pmtiles`,
  contoursUrl: `${base}/map-packs/avacha-group.contours.geojson`,
  terrainMaxZoom: 13,
  attribution: '© Copernicus DEM (ESA)',
};
type Layer = { id: string; type: string; source?: string; paint?: Record<string, unknown> };
type Style = { layers: Layer[] };

describe('гипсометрия', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: слой color-relief под заливками и тенью, стиль валиден`, () => {
      const style = buildVedarStyle(theme, src) as unknown as Style;
      const errs = validateStyleMin(style as never) as Array<{ message: string }>;
      expect(errs.map(e => e.message)).toEqual([]);
      const ids = style.layers.map(l => l.id);
      const relief = style.layers.find(l => l.id === 'relief')!;
      expect(relief.type).toBe('color-relief');
      expect(relief.source).toBe('terrain');
      expect(ids.indexOf('relief')).toBeGreaterThan(ids.indexOf('bg'));
      expect(ids.indexOf('relief')).toBeLessThan(ids.indexOf('hillshade'));
    });

    it(`${theme}: ступени по возрастанию, первая — море`, () => {
      const style = buildVedarStyle(theme, src) as unknown as Style;
      const relief = style.layers.find(l => l.id === 'relief')!;
      const expr = relief.paint!['color-relief-color'] as unknown[];
      expect(expr.slice(0, 3)).toEqual(['interpolate', ['linear'], ['elevation']]);
      const stops = expr.slice(3);
      const metres = stops.filter((_, i) => i % 2 === 0) as number[];
      expect(metres[0]).toBeLessThan(0);
      for (let i = 1; i < metres.length; i++) expect(metres[i]).toBeGreaterThan(metres[i - 1]);
      // Море и первая суша разделены меньше чем метром: берег — не полоса
      // переходного цвета, а линия.
      expect(metres[2] - metres[1]).toBeLessThanOrEqual(1);
      expect(metres[metres.length - 1]).toBeGreaterThanOrEqual(4750); // Ключевская 4754
    });
  }

  it('соседний район получает гипсометрию в базовом ярусе', () => {
    const b = buildRegionOverlay('dark', src, 'paratunka', 'base');
    expect(b.layers[0]!.id).toBe('relief-paratunka');
    expect(b.layers[0]!.type).toBe('color-relief');
  });

  it('тень зависит от зума: на обзоре слабее, чем вблизи', () => {
    const style = buildVedarStyle('dark', src) as unknown as Style;
    const hill = style.layers.find(l => l.id === 'hillshade')!;
    const ex = hill.paint!['hillshade-exaggeration'] as unknown[];
    expect(ex.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    const vals = ex.slice(3).filter((_, i) => i % 2 === 1) as number[];
    expect(vals[0]).toBeLessThan(vals[vals.length - 1]);
  });
});
