/**
 * /map открывается всем полуостровом (владелец 29.09, скрин карты на зуме
 * 4.0: «хочу, чтоб карта открывалась в таком масштабе»). До этого старт был
 * Петропавловск на зуме 6 — окрестности города вместо края.
 *
 * Держится связка: обзорный зум — нижний ярус тайлов (OVERVIEW_MIN_ZOOM), а
 * не голое число; центр — середина края; запасная Leaflet-карта — тот же
 * вид на единицу зума больше (256- и 512-пиксельные тайлы).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERVIEW_MIN_ZOOM } from '@/lib/map/pack-source';

const SRC = readFileSync(join(process.cwd(), 'app/map/_MapPageClient.tsx'), 'utf8');

describe('/map открывается обзором края', () => {
  it('обзорный зум — нижний ярус тайлов, а он равен 4', () => {
    expect(OVERVIEW_MIN_ZOOM).toBe(4);
    expect(SRC).toMatch(/const OVERVIEW_ZOOM = OVERVIEW_MIN_ZOOM;/);
  });

  it('центр — середина полуострова, не Петропавловск', () => {
    const m = SRC.match(/const OVERVIEW_CENTER: \[number, number\] = \[([\d.]+), ([\d.]+)\];/);
    expect(m).not.toBeNull();
    const [lat, lng] = [Number(m![1]), Number(m![2])];
    expect(lat).toBeGreaterThan(55);
    expect(lat).toBeLessThan(57);
    expect(lng).toBeGreaterThan(158.5);
    expect(lng).toBeLessThan(161);
  });

  it('карта Ведара и запасная Leaflet стартуют с обзора', () => {
    const vedarAt = SRC.indexOf('<VedarMap\n');
    expect(vedarAt).toBeGreaterThan(0);
    const vedar = SRC.slice(vedarAt, vedarAt + 3000);
    expect(vedar).toMatch(/center=\{OVERVIEW_CENTER\}\s*\n\s*zoom=\{OVERVIEW_ZOOM\}/);
    const fallbackAt = SRC.indexOf('<LeafletMap', vedarAt);
    const fallback = SRC.slice(fallbackAt, fallbackAt + 300);
    expect(fallback).toMatch(/center=\{OVERVIEW_CENTER\}\s*\n\s*zoom=\{OVERVIEW_ZOOM_LEAFLET\}/);
    expect(SRC).toMatch(/const OVERVIEW_ZOOM_LEAFLET = OVERVIEW_ZOOM \+ 1;/);
  });
});
