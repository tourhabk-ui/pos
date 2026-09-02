/**
 * Итерация пробы 02.09 («го» владельца): GLO-30 вместо GLO-90 и свои глифы.
 *
 * Первый живой рендер показал: «карта не очень качественно прорисована».
 * Причина — источник: 90 м на отсчёт, выше z12 детали не существует.
 * GLO-30 — тот же открытый набор ESA, втрое плотнее. Подписи высот были
 * отключены до своих глифов: чужой CDN сделал бы «карта сохранена» ложью.
 *
 * Сторож держит то, что легко разъезжается молча между четырьмя местами
 * (конвейер Python, контракт пакета, стиль, workflow):
 *   - предел зума один на печь и на чтение;
 *   - горизонтали берут предел у рельефа, а не хранят свою копию;
 *   - глифы: имя шрифта и диапазоны из одного места, стиль просит именно их;
 *   - заливка отказывает при неполном наборе диапазонов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACK_TERRAIN_MAXZOOM, PACK_GLYPHS, glyphKey, resolvePackSource,
} from '@/lib/map/pack-source';
import { buildVedarStyle } from '@/lib/map/vedar-style';

const ROOT = process.cwd();
const PY = readFileSync(join(ROOT, 'scripts/map-tiles/build_terrain.py'), 'utf-8');
const CT = readFileSync(join(ROOT, 'scripts/map-tiles/build_contours.py'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-build.yml'), 'utf-8');
const UP = readFileSync(join(ROOT, 'scripts/map-tiles/upload-pack.ts'), 'utf-8');
const CLIENT = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('предел зума — одно число на печь и на чтение', () => {
  it('PACK_TERRAIN_MAXZOOM равен MAXZOOM конвейера', () => {
    const m = PY.match(/^MAXZOOM = (\d+)$/m);
    expect(m, 'MAXZOOM в build_terrain.py не найден').toBeTruthy();
    expect(PACK_TERRAIN_MAXZOOM).toBe(Number(m![1]));
  });

  it('горизонтали импортируют предел у рельефа, а не хранят копию', () => {
    expect(CT).toMatch(/from build_terrain import MAXZOOM/);
    expect(CT).not.toMatch(/^MAXZOOM = \d+/m);
  });

  it('клиент берёт предел из контракта пакета, а не числом', () => {
    expect(CLIENT).toMatch(/terrainMaxZoom: fieldBaseMap\.source\.terrainMaxZoom/);
    expect(CLIENT).not.toMatch(/terrainMaxZoom: 1\d,/);
  });

  it('готовый пакет несёт предел зума', () => {
    const r = resolvePackSource('avacha-group', ['avacha-group'], 'https://s3.example.ru/b');
    expect(r.state).toBe('ready');
    if (r.state === 'ready') expect(r.terrainMaxZoom).toBe(PACK_TERRAIN_MAXZOOM);
  });
});

describe('глифы — свои, из одного места', () => {
  it('шаблон адреса — MapLibre {fontstack}/{range}.pbf под базой хранилища', () => {
    const r = resolvePackSource('avacha-group', ['avacha-group'], 'https://s3.example.ru/b/');
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    expect(r.glyphsUrl).toBe('https://s3.example.ru/b/map-packs/glyphs/{fontstack}/{range}.pbf');
    expect(r.glyphsFont).toBe(PACK_GLYPHS.fontstack);
    expect(glyphKey('Noto Sans Regular', '0-255')).toBe('map-packs/glyphs/Noto Sans Regular/0-255.pbf');
  });

  it('диапазоны — цифры со знаком градуса и кириллица', () => {
    expect(PACK_GLYPHS.ranges).toContain('0-255');
    expect(PACK_GLYPHS.ranges).toContain('1024-1279');
  });

  it('стиль просит именно наш шрифт, а не умолчальный Open Sans', () => {
    const style = buildVedarStyle('dark', {
      terrainUrl: 'pmtiles://x', contoursUrl: 'y', terrainMaxZoom: 13, attribution: 'a',
      glyphsUrl: 'https://s3.example.ru/b/map-packs/glyphs/{fontstack}/{range}.pbf',
      glyphsFont: PACK_GLYPHS.fontstack,
    }) as { layers: Array<{ id: string; layout?: Record<string, unknown> }> };
    const label = style.layers.find((l) => l.id === 'contour-label');
    expect(label, 'слоя подписей нет при заданных глифах').toBeTruthy();
    expect(label!.layout!['text-font']).toEqual([PACK_GLYPHS.fontstack]);
  });

  it('workflow качает глифы шагом и передаёт каталог заливке', () => {
    expect(WF).toMatch(/name: Глифы/);
    // Имя шрифта и диапазоны читаются из pack-source.ts, второго списка нет.
    expect(WF).toMatch(/fontstack: '\(\[\^'\]\+\)'/);
    expect(WF).toMatch(/\.cache\/packs\/glyphs"\s*$/m);
  });

  it('заливка отказывает при неполном наборе диапазонов', () => {
    expect(UP).toMatch(/Не хватает диапазонов глифов/);
    expect(UP).toMatch(/PACK_GLYPHS\.ranges\.filter/);
  });
});
