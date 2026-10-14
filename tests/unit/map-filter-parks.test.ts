/**
 * Чип «Леса и парки» на /map показывает охраняемые территории (14.10).
 *
 * Чип сверял род места равенством, и когда заповедники и парки получили
 * свои роды (миграции 1240, 1243, 1246: `reserve`, `national_park`, `park`),
 * чип с подписью «Леса и парки» перестал показывать парки. Состав чипа —
 * lib/map/place-filter; здесь он судится вычислением: настоящее выражение
 * фильтра MapLibre на месте каждого рода и отбор списка мест над картой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { placeFilterKinds, placeKindFilterExpr, placeMatchesFilter } from '@/lib/map/place-filter';
import { placeMarkerSvg, PLACE_KIND_COLOR, PLACE_MARKER_KINDS } from '@/lib/map/place-marker-icons';

/** Пропустит ли слой карты место этого рода при выбранном чипе. */
function layerShows(filter: string, kind: string): boolean {
  const f = featureFilter(placeKindFilterExpr(filter) as never, 'layers[0].filter');
  return f.filter({ zoom: 10 } as never, { type: 1, properties: { kind } } as never);
}

describe('«Леса и парки»', () => {
  it('слой карты показывает лес, природный парк, заповедник, национальный парк и заказник — и не показывает озеро', () => {
    for (const kind of ['forest', 'park', 'reserve', 'national_park', 'zakaznik']) {
      expect(layerShows('forest', kind), kind).toBe(true);
    }
    expect(layerShows('forest', 'lake')).toBe(false);
    expect(layerShows('forest', 'volcano')).toBe(false);
  });

  it('список мест над картой отбирает тот же состав', () => {
    expect(placeFilterKinds('forest')).toEqual(['forest', 'park', 'reserve', 'national_park', 'zakaznik']);
    expect(placeMatchesFilter('park', 'forest')).toBe(true);
    expect(placeMatchesFilter('reserve', 'forest')).toBe(true);
    expect(placeMatchesFilter('lake', 'forest')).toBe(false);
    expect(placeMatchesFilter(null, 'forest')).toBe(false);
  });

  it('остальные чипы — один род, как прежде', () => {
    expect(layerShows('volcano', 'volcano')).toBe(true);
    expect(layerShows('volcano', 'mountain')).toBe(false);
    expect(placeFilterKinds('lake')).toEqual(['lake']);
  });

  it('/map не сверяет род места равенством мимо состава чипа', () => {
    const client = readFileSync(join(process.cwd(), 'app/map/_MapPageClient.tsx'), 'utf-8');
    expect(client).not.toMatch(/r\.locationType === (filterNow|id)\b/);
  });
});

describe('природный парк на карте', () => {
  it('у `park` свой значок охраняемой территории и зелёный цвет леса', () => {
    expect(PLACE_MARKER_KINDS).toContain('park');
    expect(placeMarkerSvg('#15803D', 'park')).toBe(placeMarkerSvg('#15803D', 'reserve'));
    expect(placeMarkerSvg('#15803D', 'park')).not.toBe(placeMarkerSvg('#15803D', 'other'));
    expect(PLACE_KIND_COLOR.park).toBe(PLACE_KIND_COLOR.forest);
  });
});
