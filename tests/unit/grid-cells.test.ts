/**
 * Сторож сетки «вся Камчатка» (03.09): клетки — второй слой реестра
 * пакетов. Держит: форму id и bbox, отсутствие дублей, что клетки не
 * попадают в список районов для человека, и порядок выбора — нарисованный
 * район прежде клетки.
 */
import { describe, it, expect } from 'vitest';
import { GRID_CELLS, gridCellId, gridCellById, isGridCellId, gridCellsForPoint } from '@/lib/geo/grid-cells';
import { REGIONS_LIST, packRegionBbox, packRegionCenter, isRegionId } from '@/lib/geo/regions';
import { regionsForPoint, builtRegionPacks } from '@/lib/map/field-base-map';
import { BUILT_GRID_CELLS, BUILT_PACK_REGIONS, resolvePackSource } from '@/lib/map/pack-source';

describe('сетка клеток края', () => {
  it('каждая клетка — ровно 1°×1° с id по юго-западному углу, без дублей', () => {
    const ids = new Set<string>();
    for (const c of GRID_CELLS) {
      expect(c.id).toBe(gridCellId(c.bbox.south, c.bbox.west));
      expect(c.bbox.north - c.bbox.south).toBe(1);
      expect(c.bbox.east - c.bbox.west).toBe(1);
      expect(Number.isInteger(c.bbox.south) && Number.isInteger(c.bbox.west)).toBe(true);
      expect(c.landDeg2).toBeGreaterThanOrEqual(0.02);
      expect(c.landDeg2).toBeLessThanOrEqual(1);
      expect(ids.has(c.id), `дубль ${c.id}`).toBe(false);
      ids.add(c.id);
    }
    // Полигон края (Natural Earth 10m): 50.86..64.93 с.ш., 155.55..174.51 в.д.
    for (const c of GRID_CELLS) {
      expect(c.bbox.south).toBeGreaterThanOrEqual(50);
      expect(c.bbox.north).toBeLessThanOrEqual(65);
      expect(c.bbox.west).toBeGreaterThanOrEqual(155);
      expect(c.bbox.east).toBeLessThanOrEqual(175);
    }
    expect(GRID_CELLS.length).toBeGreaterThan(100);
  });

  it('клетки не попадают в список районов для человека', () => {
    for (const c of GRID_CELLS) expect(isRegionId(c.id)).toBe(false);
    expect(REGIONS_LIST.some(r => r.id.startsWith('cell-'))).toBe(false);
  });

  it('bbox и центр по id — для района и для клетки одной функцией', () => {
    expect(packRegionBbox('avacha-group')).toEqual({ south: 52.8, west: 158.4, north: 53.6, east: 159.4 });
    expect(packRegionBbox('cell-52n157e')).toEqual({ south: 52, west: 157, north: 53, east: 158 });
    expect(packRegionCenter('cell-52n157e')).toEqual({ lat: 52.5, lng: 157.5 });
    expect(packRegionBbox('cell-40n100e')).toBeNull();
    expect(isGridCellId('cell-52n157e')).toBe(true);
    expect(isGridCellId('cell-52n157')).toBe(false);
    expect(gridCellById('nope')).toBeNull();
  });

  it('Верхне-Опальские (52.4417/157.7339) накрыты клеткой cell-52n157e', () => {
    expect(gridCellsForPoint(52.4417, 157.7339).map(c => c.id)).toEqual(['cell-52n157e']);
  });

  it('точка внутри нарисованного района берёт район, клетка — только следом', () => {
    // Авачинский вулкан: район avacha-group и клетка cell-53n158e.
    const ids = regionsForPoint(53.26, 158.83);
    expect(ids[0]).toBe('avacha-group');
    expect(ids).toContain('cell-53n158e');
    expect(ids.indexOf('avacha-group')).toBeLessThan(ids.indexOf('cell-53n158e'));
  });

  it('обещание клетки — отдельный список; несобранная клетка честно not_built', () => {
    for (const id of BUILT_GRID_CELLS) expect(isGridCellId(id), id).toBe(true);
    const unbuilt = GRID_CELLS.find(c => !BUILT_GRID_CELLS.includes(c.id));
    if (unbuilt) {
      expect(resolvePackSource(unbuilt.id, BUILT_PACK_REGIONS, 'https://x').state).toBe('not_built');
    }
    for (const id of BUILT_GRID_CELLS) {
      const s = resolvePackSource(id, BUILT_PACK_REGIONS, 'https://x');
      expect(s.state).toBe('ready');
      if (s.state === 'ready') {
        expect(s.vectorUrl).toContain(`${id}.vector.pmtiles`);
        expect(Object.keys(s.osmUrls).length).toBeGreaterThan(0);
      }
    }
    // Собранные клетки подкладываются на карту наравне с районами.
    const packs = builtRegionPacks('https://x');
    for (const id of BUILT_GRID_CELLS) expect(packs.some(p => p.region === id)).toBe(true);
  });
});
