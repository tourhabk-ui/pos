/**
 * Сторож: контур края рисуется раньше рельефа и без хранилища (03.10).
 *
 * Скрин владельца 03.10 11:45 с 4G: подложка из хранилища не пришла, карта —
 * пустой бежевый прямоугольник. Владелец: «сначала прорисовывать контур и
 * потом заполнять рельеф». Контур обязан ехать ДАННЫМИ в стиле (не адресом
 * в хранилище, который может не ответить) и лежать сразу над фоном — под
 * рельефом и морем, которые закроют его, когда придут.
 */
import { describe, it, expect } from 'vitest';
import { buildVedarStyle, LAND_OUTLINE_SOURCE } from '@/lib/map/vedar-style';
import { landGeoJSON, landVerdict } from '@/lib/geo/land';

type Style = {
  sources: Record<string, { type: string; data?: unknown }>;
  layers: Array<{ id: string; type: string; source?: string }>;
};
const base = { terrainUrl: 'pmtiles://x', contoursUrl: 'y', terrainMaxZoom: 13, attribution: 'a' };

describe('контур края в стиле карты', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: источник — данные, а не адрес`, () => {
      const style = buildVedarStyle(theme, base) as unknown as Style;
      const src = style.sources[LAND_OUTLINE_SOURCE];
      expect(src?.type).toBe('geojson');
      expect(typeof src?.data).toBe('object');
    });

    it(`${theme}: слои контура — сразу над фоном, ниже рельефа`, () => {
      const ids = (buildVedarStyle(theme, base) as unknown as Style).layers.map(l => l.id);
      const bg = ids.indexOf('bg');
      const fill = ids.indexOf('land-outline-fill');
      const coast = ids.indexOf('land-outline-coast');
      const relief = ids.findIndex(id => id.startsWith('relief'));
      expect(bg).toBe(0);
      expect(fill).toBe(1);
      expect(coast).toBe(2);
      expect(relief).toBeGreaterThan(coast);
    });
  }
});

describe('контур — тот же берег, что судит «суша или море»', () => {
  it('Петропавловск внутри колец суши, Авачинский залив — снаружи', () => {
    expect(landVerdict(53.02, 158.65)).toBe('land');
    expect(landVerdict(52.8, 159.2)).toBe('sea');
    const fc = landGeoJSON();
    expect(fc.features.length).toBeGreaterThan(0);
    for (const f of fc.features) {
      const ring = f.geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });
});
