/**
 * Привязка мест к маршрутам — правила подсказчика.
 *
 * Сторож стоит на главном уроке миграции 167: близость НЕ доказывает, что
 * маршрут проходит через место, поэтому имя весит больше расстояния, а
 * родовые слова («вулкан», «источники») не должны опознавать ничего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  significantTokens, nameMatchScore, distanceKm, suggestRoutes, linkPairProblems,
  type RouteCandidateInput,
} from '@/lib/routes/place-link';

const ROOT = process.cwd();

describe('значимые слова названия', () => {
  it('родовые слова отбрасываются', () => {
    expect(significantTokens('Малкинские горячие источники')).toEqual(['малкинские']);
    expect(significantTokens('Вулкан Плоский Толбачик')).toEqual(['плоский', 'толбачик']);
  });

  it('название из одних родовых слов не опознаёт ничего', () => {
    expect(significantTokens('Горячие источники')).toEqual([]);
    expect(nameMatchScore('Горячие источники', 'Термальные источники Паратунки')).toBe(0);
  });
});

describe('совпадение имени', () => {
  it('падежный хвост не мешает — сравниваются основы', () => {
    expect(nameMatchScore('Малкинские горячие источники', 'Малкинские')).toBe(1);
    expect(nameMatchScore('Вулкан Авачинский', 'Восхождение на Авачинский вулкан')).toBe(1);
  });

  it('чужой маршрут не совпадает', () => {
    expect(nameMatchScore('Вулкан Горелый', 'Восхождение на Мутновский вулкан')).toBe(0);
  });

  it('частичное совпадение считается долей', () => {
    // «Плоский» есть, «Толбачик» есть → 1; только один из двух → 0.5
    expect(nameMatchScore('Вулкан Плоский Толбачик', 'Вокруг Толбачиков')).toBe(0.5);
  });
});

describe('подсказка кандидатов', () => {
  const routes: RouteCandidateInput[] = [
    { id: 'r-malki', title: 'Малкинские', lat: 53.28, lng: 157.58, hasGeometry: true, waypointCount: 2 },
    { id: 'r-near', title: 'Термальный день', lat: 53.29, lng: 157.59, hasGeometry: false, waypointCount: 0 },
    { id: 'r-far', title: 'Ключевская группа', lat: 56.05, lng: 160.64, hasGeometry: true, waypointCount: 5 },
  ];
  const place = { name: 'Малкинские горячие источники', lat: 53.28, lng: 157.58 };

  it('маршрут с именем места идёт первым, даже если сосед ближе', () => {
    const out = suggestRoutes({ ...place, lat: 53.29, lng: 157.59 }, routes);
    expect(out[0].routeId).toBe('r-malki');
    expect(out[0].nameScore).toBe(1);
  });

  it('далёкие и безымянные кандидаты не показываются', () => {
    const out = suggestRoutes(place, routes, { maxKm: 20 });
    expect(out.map(c => c.routeId)).not.toContain('r-far');
  });

  it('место без координат всё равно получает подсказку по имени', () => {
    const out = suggestRoutes({ name: 'Малкинские горячие источники', lat: null, lng: null }, routes);
    expect(out).toHaveLength(1);
    expect(out[0].routeId).toBe('r-malki');
    expect(out[0].distanceKm).toBeNull();
  });
});

describe('расстояние', () => {
  it('Петропавловск — Елизово примерно 27 км', () => {
    const d = distanceKm(53.024, 158.643, 53.183, 158.388);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(30);
  });
});

describe('валидация пар', () => {
  it('повтор пары — проблема', () => {
    expect(linkPairProblems([
      { place: 'p', route: 'r' }, { place: 'p', route: 'r' },
    ])).toHaveLength(1);
  });

  it('одно место в несколько маршрутов — норма (вершина на трёх тропах)', () => {
    expect(linkPairProblems([
      { place: 'p', route: 'r1' }, { place: 'p', route: 'r2' },
    ])).toHaveLength(0);
  });
});

describe('обещания эндпоинта', () => {
  it('привязка только поимённая — авто-режима по радиусу нет', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link/route.ts'), 'utf-8');
    expect(src).toContain('pairs');
    expect(src, 'радиусный авто-режим повторил бы паутины миграции 167')
      .not.toMatch(/INSERT INTO route_waypoints[\s\S]{0,400}JOIN places/);
  });

  it('привязка идёт только к живым маршрутам и живым местам', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link/route.ts'), 'utf-8');
    expect(src).toContain('r.is_visible = true');
    expect(src).toContain('r.merged_into_id IS NULL');
    expect(src).toContain('p.merged_into_id IS NULL');
  });
});
