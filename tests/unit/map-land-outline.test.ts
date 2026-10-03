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
import { buildVedarStyle, LAND_OUTLINE_SOURCE, OCEAN_UNDER_PREFIX } from '@/lib/map/vedar-style';
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

    it(`${theme}: слои контура — над фоном и подложкой воды, ниже рельефа`, () => {
      const ids = (buildVedarStyle(theme, base) as unknown as Style).layers.map(l => l.id);
      const fill = ids.indexOf('land-outline-fill');
      const coast = ids.indexOf('land-outline-coast');
      const relief = ids.findIndex(id => id.startsWith('relief'));
      // Под контуром — только фон и подложка воды (она в море, контур на суше).
      expect(ids.slice(0, fill).every(id => id === 'bg' || id.startsWith(OCEAN_UNDER_PREFIX))).toBe(true);
      expect(coast).toBe(fill + 1);
      expect(relief).toBeGreaterThan(coast);
    });
  }
});

describe('контур — тот же берег, что судит «суша или море»', () => {
  it('Петропавловск внутри колец суши, Авачинский залив — снаружи', () => {
    expect(landVerdict(53.02, 158.65)).toBe('land');
    expect(landVerdict(52.8, 159.2)).toBe('sea');
    const fc = landGeoJSON();
    const land = fc.features.filter(f => f.properties.kind === 'land');
    expect(land.length).toBeGreaterThan(0);
    for (const f of land) {
      if (f.geometry.type !== 'Polygon') throw new Error('суша — не полигон');
      const ring = f.geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  it('берег рисуется исходными кусками — без швов по рамке (прогон 8)', () => {
    const coast = landGeoJSON().features.filter(f => f.properties.kind === 'coast');
    expect(coast.length).toBeGreaterThan(0);
    // Ни одно звено берега не идёт вдоль рамки: шов замыкания материка
    // (154° / 63.5°) — не берег, и обводить его нельзя.
    for (const f of coast) {
      if (f.geometry.type !== 'LineString') throw new Error('берег — не линия');
      const pts = f.geometry.coordinates;
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1];
        const [x2, y2] = pts[i];
        const alongWest = x1 === 154 && x2 === 154;
        const alongNorth = y1 === 63.5 && y2 === 63.5;
        expect(alongWest || alongNorth).toBe(false);
      }
    }
  });

  it('заливка берёт только сушу, обводка — только берег', () => {
    const layers = (buildVedarStyle('dark', base) as unknown as { layers: Array<{ id: string; filter?: unknown }> }).layers;
    expect(JSON.stringify(layers.find(l => l.id === 'land-outline-fill')?.filter)).toContain('land');
    expect(JSON.stringify(layers.find(l => l.id === 'land-outline-coast')?.filter)).toContain('coast');
  });
});
