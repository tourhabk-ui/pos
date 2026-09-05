/**
 * Ярусы рельефа не пересекаются В СЛОЯХ, а не только в комментарии (05.09,
 * снимки 8-9). Растровый источник обзора (z4-7) MapLibre тянет overzoom-ом
 * и выше z7, а его гипсометрия непрозрачна: без `maxzoom` у слоёв обзор
 * ложился поверх клетки на z10-12 везде, где у тайла z7 есть данные, и кадр
 * размывался прямоугольниками по границам тайлов z7 — при полном архиве
 * клетки и всех её тайлах в loaded. Слоям обзора — предел z8 (исключающий),
 * тот же, что у океана; слоям клеток и районов предела нет: выше z13 они
 * тянутся overzoom-ом намеренно (build_terrain.py, «мягкость, не ложь»).
 */
import { describe, it, expect } from 'vitest';
import { buildVedarStyle, buildRegionOverlay, OVERVIEW_LAYER_MAXZOOM, type VedarStyleSources } from '@/lib/map/vedar-style';
import { OVERVIEW_MAX_ZOOM, PACK_TERRAIN_MAXZOOM } from '@/lib/map/pack-source';
import { OVERVIEW_ID } from '@/lib/geo/regions';

function sources(terrainMaxZoom: number): VedarStyleSources {
  return {
    terrainUrl: 'pmtiles://https://example.test/x.terrain.pmtiles',
    contoursUrl: 'https://example.test/x.contours.geojson',
    terrainMaxZoom,
    attribution: '© Copernicus DEM (ESA)',
    glyphsUrl: null,
    oceanUrl: terrainMaxZoom === OVERVIEW_MAX_ZOOM ? 'https://example.test/ocean.geojson' : null,
  };
}

type Layer = { id: string; type: string; maxzoom?: number };

function terrainLayers(layers: unknown[]): Layer[] {
  return (layers as Layer[]).filter((l) => l.type === 'color-relief' || l.type === 'hillshade' || l.id.startsWith('vedar-ocean'));
}

describe('предел зума слоёв обзорного яруса', () => {
  it('OVERVIEW_LAYER_MAXZOOM — на единицу выше последнего зума обзора (исключающий maxzoom MapLibre)', () => {
    expect(OVERVIEW_LAYER_MAXZOOM).toBe(OVERVIEW_MAX_ZOOM + 1);
    expect(OVERVIEW_LAYER_MAXZOOM).toBe(8);
  });

  it('основной стиль обзора: гипсометрия, тень и океан кончаются на z8', () => {
    const style = buildVedarStyle('dark', sources(OVERVIEW_MAX_ZOOM)) as { layers: unknown[] };
    const tl = terrainLayers(style.layers);
    expect(tl.map((l) => l.type)).toEqual(expect.arrayContaining(['color-relief', 'hillshade', 'fill']));
    for (const l of tl) expect(l.maxzoom, l.id).toBe(OVERVIEW_LAYER_MAXZOOM);
  });

  it('подкладка обзора рядом с клеткой: те же пределы — поверх клетки на z10 обзор не рисуется', () => {
    const ov = buildRegionOverlay('dark', sources(OVERVIEW_MAX_ZOOM), OVERVIEW_ID, 'base');
    const tl = terrainLayers(ov.layers);
    expect(tl.length).toBeGreaterThanOrEqual(2);
    for (const l of tl) expect(l.maxzoom, l.id).toBe(OVERVIEW_LAYER_MAXZOOM);
  });

  it('клетка и район: у гипсометрии и тени предела нет — выше z13 overzoom намеренный', () => {
    const style = buildVedarStyle('light', sources(PACK_TERRAIN_MAXZOOM)) as { layers: unknown[] };
    for (const l of terrainLayers(style.layers)) expect(l.maxzoom, l.id).toBeUndefined();
    const ov = buildRegionOverlay('light', sources(PACK_TERRAIN_MAXZOOM), 'cell-54n158e', 'base');
    for (const l of terrainLayers(ov.layers)) expect(l.maxzoom, l.id).toBeUndefined();
  });
});
