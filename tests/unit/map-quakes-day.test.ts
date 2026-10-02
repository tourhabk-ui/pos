/**
 * Толчки за последние сутки на /map (владелец 02.10, скрины eqkam: шесть
 * толчков у Авачинского залива за вечер, M6.2 и повторные — на карте ни
 * одного). Лента сейсмики отдавала 15 последних за 48 ч и только экрану
 * безопасности; на карте слоя толчков не было вовсе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSameQuakes, SAME_QUAKE_KM, SAME_QUAKE_SECONDS, type MapQuake } from '@/lib/services/safety/seismic-feed';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

const T0 = Date.UTC(2026, 9, 2, 16, 34, 39);
const q = (id: string, magnitude: number, dtSec: number, lat: number, lng: number): MapQuake =>
  ({ id, magnitude, time: T0 + dtSec * 1000, depth: null, lat, lng });

describe('склейка одного толчка из разных источников', () => {
  it('eqkam M6.2 и USGS M6.0 через 40 с в 8 км — одна точка, остаётся бо́льшая магнитуда', () => {
    const out = mergeSameQuakes([q('usgs', 6.0, 40, 51.62, 159.70), q('eqkam', 6.2, 0, 51.566, 159.6741)]);
    expect(out.map(e => e.id)).toEqual(['eqkam']);
  });

  it('рой со скринов владельца — шесть разных толчков остаются шестью', () => {
    const swarm = [
      q('a', 4.8, -1950, 52.9039, 159.0911), // 16:02, у Петропавловска
      q('b', 6.2, 0, 51.5660, 159.6741),     // 16:34
      q('c', 4.8, 936, 51.5962, 159.6684),   // 16:50
      q('d', 4.5, 1372, 51.5471, 159.8130),  // 16:57
      q('e', 4.5, 1836, 51.6125, 159.7022),  // 17:05
      q('f', 4.0, 2426, 51.6424, 159.8048),  // 17:15
    ];
    const out = mergeSameQuakes(swarm);
    expect(out).toHaveLength(6);
    // Новые первыми.
    expect(out[0].id).toBe('f');
  });

  it('пороги склейки — 2 минуты и 50 км', () => {
    expect(SAME_QUAKE_SECONDS).toBe(120);
    expect(SAME_QUAKE_KM).toBe(50);
    // Тот же час, то же место, но через 3 минуты — уже другой толчок.
    expect(mergeSameQuakes([q('x', 4.5, 0, 51.6, 159.7), q('y', 4.4, 180, 51.6, 159.7)])).toHaveLength(2);
  });
});

describe('лента: режим окна для карты', () => {
  const FEED = read('lib/services/safety/seismic-feed.ts');
  const ROUTE = read('app/api/safety/seismic/route.ts');

  it('все толчки с координатами за окно, без обрезки до 15', () => {
    const fn = FEED.slice(FEED.indexOf('export async function getQuakesForMap'));
    expect(fn).toMatch(/INTERVAL '1 hour' \* \$1/);
    expect(fn).toMatch(/lat IS NOT NULL AND lng IS NOT NULL/);
    expect(fn).not.toMatch(/LIMIT 15/);
    expect(fn).toMatch(/mergeSameQuakes\(events\)/);
  });

  it('?hours проверяется Zod, отказ запроса — 502, а не пустой список', () => {
    expect(ROUTE).toMatch(/z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(QUAKE_MAP_MAX_HOURS\)/);
    expect(ROUTE).toMatch(/status: 502/);
  });
});

describe('карта: слой и страница', () => {
  const STYLE = read('lib/map/vedar-style.ts');
  const MAP = read('components/shared/VedarMap.tsx');
  const PAGE = read('app/map/_MapPageClient.tsx');
  const HOOK = read('hooks/useMapQuakes.ts');

  it('слой толчков — поверх мест в базовом стиле', () => {
    const places = STYLE.indexOf("...vedarPlaceLayers(sources, p, ''),\n      // Толчки");
    expect(places).toBeGreaterThan(0);
    expect(STYLE.indexOf('quakeLayer(p)')).toBeGreaterThan(places);
  });

  it('тап по толчку проверяется раньше тапа по месту', () => {
    const click = MAP.slice(MAP.indexOf("map.on('click'"));
    expect(click.indexOf('QUAKES_LAYER')).toBeLessThan(click.indexOf("startsWith('vedar-places')"));
  });

  it('/map просит сутки и передаёт толчки карте', () => {
    expect(HOOK).toMatch(/MAP_QUAKE_HOURS = 24/);
    expect(HOOK).toMatch(/\/api\/safety\/seismic\?hours=\$\{MAP_QUAKE_HOURS\}/);
    expect(PAGE).toMatch(/quakes=\{quakes\}/);
    expect(PAGE).toMatch(/onQuakeClick=\{setQuakeHit\}/);
  });

  it('«не прочитали» называется словами, а не нулём', () => {
    expect(PAGE).toMatch(/Толчки: не прочитаны/);
    expect(HOOK).toMatch(/setState\('failed'\)/);
  });
});
