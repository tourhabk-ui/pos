/**
 * Ремонт данных — Шаг 10b: анлинк изолированных точек-беглецов.
 * strayWaypointIndices отвязывает чужую точку от маршрута, НЕ трогая длинные
 * линейные маршруты и «подборки мест» (там нет связного ядра).
 */

import { describe, it, expect, vi } from 'vitest';

// Модуль импортирует pool на верхнем уровне — мокаем, хотя функция чистая.
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

import { strayWaypointIndices } from '@/lib/services/data-repair';

// Кластер у Авачинского вулкана (точки в пределах ~3 км).
const VOLCANO: Array<[number, number]> = [
  [53.28, 158.72], [53.29, 158.73], [53.27, 158.71], [53.30, 158.74],
];

describe('strayWaypointIndices — анлинк беглецов', () => {
  it('кейс владельца: «Каменный лес княженика» (285 км) — беглец, отвязать', () => {
    const coords: Array<[number, number]> = [...VOLCANO, [55.7, 160.5]]; // ~290 км
    expect(strayWaypointIndices(coords)).toEqual([4]);
  });

  it('пляж + визит-центр рядом друг с другом, но далеко от ядра — оба беглецы', () => {
    // Пляж и центр в ~3 км друг от друга, но ~30 км южнее вулканного ядра.
    const coords: Array<[number, number]> = [...VOLCANO, [53.00, 158.72], [53.00, 158.68]];
    expect(strayWaypointIndices(coords).sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it('длинный линейный маршрут (цепочка ≤10 км) — ядро = весь маршрут, 0 анлинков', () => {
    // 8 точек шагом ~5.5 км: одна связная компонента, размах ~44 км.
    const coords: Array<[number, number]> = Array.from({ length: 8 }, (_, i) => [53.0 + i * 0.05, 158.0]);
    expect(strayWaypointIndices(coords)).toEqual([]);
  });

  it('«подборка мест по всему краю» (все точки далеко друг от друга) — нет ядра, не трогаем', () => {
    const coords: Array<[number, number]> = [
      [53.0, 158.0], [54.5, 159.5], [56.0, 161.0], [52.5, 156.5],
    ];
    expect(strayWaypointIndices(coords)).toEqual([]);
  });

  it('слишком мало точек (<4) — судить не о чем', () => {
    expect(strayWaypointIndices([...VOLCANO.slice(0, 2), [55.7, 160.5]])).toEqual([]);
  });

  it('компактный маршрут без беглецов — 0 анлинков', () => {
    expect(strayWaypointIndices(VOLCANO)).toEqual([]);
  });
});
