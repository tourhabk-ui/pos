/**
 * Число зума рядом с кнопками «+»/«−» (владелец 05.09: «чтоб отражался зум
 * для инфы, рядом с кнопками масштаба»).
 *
 * Держится три вещи:
 *  1. число читается с карты через ту же ручку, что и кнопки, — одна ручка
 *     на карту и на приборный ряд снаружи (handleFor), второго объекта нет;
 *  2. подписка на zoom отписывается — иначе каждый монтаж кнопок оставлял бы
 *     слушателя на карте;
 *  3. перерисовка только при смене первого знака после запятой: событие zoom
 *     идёт покадрово при щипке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

describe('зум числом у кнопок масштаба', () => {
  it('ручка карты отдаёт зум и подписку, одна фабрика на оба места', () => {
    expect(SRC).toMatch(/getZoom\(\): number;/);
    expect(SRC).toMatch(/onZoom\(cb: \(zoom: number\) => void\): \(\) => void;/);
    expect(SRC).toMatch(/function handleFor\(map: MLMap\): VedarMapHandle/);
    expect(SRC).toMatch(/onControlsRef\.current\?\.\(handleFor\(map\)\)/);
    expect(SRC).toMatch(/<VedarZoomButtons handle=\{inlineHandle\} \/>/);
    // Ручных объектов с zoomIn/zoomOut не осталось — только фабрика.
    expect(SRC.match(/zoomIn: \(\) => /g)?.length ?? 0).toBe(1);
  });

  it('подписка отписывается, обновление — по первому знаку после запятой', () => {
    expect(SRC).toMatch(/map\.on\('zoom', tick\)/);
    expect(SRC).toMatch(/map\.off\('zoom', tick\)/);
    expect(SRC).toMatch(/return handle\.onZoom\(/);
    expect(SRC).toMatch(/Math\.round\(prev \* 10\) === Math\.round\(z \* 10\)/);
  });

  it('показание непрозрачное, число с одним знаком, tabular-nums', () => {
    expect(SRC).toMatch(/zoom\.toFixed\(1\)/);
    expect(SRC).toMatch(/className="tabular-nums"/);
    expect(SRC).toMatch(/background: 'var\(--bg-card\)'/);
  });
});
