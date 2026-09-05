/**
 * Последняя известная точка (lib/offline/last-fix.ts) и то, как экран «На
 * маршруте» открывает подложку первой (скрин владельца 02.09: «почему
 * сначала загружается старая карта?»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAST_FIX_KEY, LAST_FIX_MAX_AGE_MS, parseLastFix, readLastFix, writeLastFix, serializeLastFix,
} from '@/lib/offline/last-fix';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    map: m,
  };
}

const NOW = 1_800_000_000_000;

describe('последняя точка: запись и чтение', () => {
  it('точка на Камчатке проходит круг запись → чтение', () => {
    const st = memStorage();
    expect(writeLastFix(st, { lat: 53.1, lng: 158.6, t: NOW })).toBe(true);
    expect(readLastFix(st, NOW)).toEqual({ lat: 53.1, lng: 158.6, t: NOW });
  });

  it('неправдоподобная координата не пишется и не читается', () => {
    const st = memStorage();
    expect(writeLastFix(st, { lat: 0, lng: 0, t: NOW })).toBe(false);
    expect(st.map.size).toBe(0);
    expect(parseLastFix(serializeLastFix({ lat: 59.5, lng: 150.8, t: NOW }), NOW)).toBeNull();
  });

  it('старше месяца — точки нет: человек мог улететь', () => {
    const raw = serializeLastFix({ lat: 53.1, lng: 158.6, t: NOW - LAST_FIX_MAX_AGE_MS - 1 });
    expect(parseLastFix(raw, NOW)).toBeNull();
    expect(parseLastFix(serializeLastFix({ lat: 53.1, lng: 158.6, t: NOW - 1000 }), NOW)).not.toBeNull();
  });

  it('мусор в хранилище — null, не падение', () => {
    for (const raw of [null, '', '{', '[1]', '["a","b","c"]', '{"lat":53}']) {
      expect(parseLastFix(raw, NOW)).toBeNull();
    }
    const throwing = { getItem: () => { throw new Error('quota'); } };
    expect(readLastFix(throwing, NOW)).toBeNull();
  });

  it('ключ версионирован', () => {
    expect(LAST_FIX_KEY).toMatch(/_v\d+$/);
  });
});

describe('экран «На маршруте» открывает подложку по последней точке', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('последняя точка — четвёртый источник выбора подложки', () => {
    expect(SRC).toMatch(/\?\?\s*fromRoute\s*\n\s*\?\?\s*lastFix/);
  });

  it('пока точки нет и маршрут грузится — подложки нет, а не старая карта', () => {
    expect(SRC).toContain("kind: 'pending' as const");
    expect(SRC).toMatch(/fieldBaseMap\.kind === 'pending' \?/);
  });

  it('живой фикс ложится на диск', () => {
    expect(SRC).toMatch(/writeLastFix\(window\.localStorage/);
    expect(SRC).toMatch(/setLastFix\(readLastFix\(window\.localStorage\)\)/);
  });
});

describe('своя карта принимает жесты', () => {
  const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');

  it('стили MapLibre подключены — без них нет touch-action:none и щипка', () => {
    expect(MAP).toContain("import 'maplibre-gl/dist/maplibre-gl.css'");
    expect(MAP).toMatch(/touchAction:\s*'none'/);
  });

  it('масштаб есть и кнопками', () => {
    // 05.09: ручка собирается фабрикой handleFor(map) — одна на кнопки на
    // карте и в приборном ряду; кнопки зовут её, она зовёт карту.
    expect(MAP).toMatch(/zoomIn: \(\) => map\.zoomIn\(\)/);
    expect(MAP).toMatch(/zoomOut: \(\) => map\.zoomOut\(\)/);
    expect(MAP).toMatch(/if \(dir > 0\) handle\.zoomIn\(\); else handle\.zoomOut\(\);/);
    expect(MAP).toMatch(/aria-label=\{label\}/);
  });
});
