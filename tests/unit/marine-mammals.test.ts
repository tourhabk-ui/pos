/**
 * Сторож правил о морских млекопитающих (постановление № 285-П, памятка 30.09).
 *
 * Числа живут в одном месте — lib/safety/marine-mammals. Здесь: они совпадают
 * с матрицей памятки, ответ агента и страница берут их оттуда, а не из копии,
 * и справка добавляется только к местам-лежбищам.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  MARINE_DISTANCES,
  MARINE_BOAT,
  MARINE_RULES_SOURCE,
  isMarineMammalPlace,
  marineMammalNote,
} from '@/lib/safety/marine-mammals';

const read = (p: string) =>
  readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('правила о морских млекопитающих', () => {
  it('матрица расстояний совпадает с памяткой', () => {
    expect(MARINE_DISTANCES.map(d => d.metres)).toEqual([150, 200, 200, 200, 500, 500, 1000, 1500]);
  });

  it('числа подхода с воды совпадают с памяткой', () => {
    expect(MARINE_BOAT.motorStopAtMetres).toBe(500);
    expect([...MARINE_BOAT.motorSlowKmh]).toEqual([5, 6]);
    expect([...MARINE_BOAT.pauseMinutes]).toEqual([10, 15]);
    expect([...MARINE_BOAT.finalKmh]).toEqual([2, 4]);
    expect(MARINE_BOAT.nearestMetres).toBe(200);
    expect(MARINE_BOAT.retreatMetres).toBe(500);
    expect(MARINE_BOAT.minBetweenBoatsMetres).toBe(15);
    expect(MARINE_BOAT.maxBoatsAtSmallHaulout).toBe(4);
  });

  it('источник назван: постановление № 285-П', () => {
    expect(MARINE_RULES_SOURCE).toContain('285-П');
    expect(MARINE_RULES_SOURCE).toContain('05.07.2021');
    expect(marineMammalNote()).toContain('285-П');
  });

  it('справка называет ключевые дистанции', () => {
    const n = marineMammalNote();
    for (const s of ['200 м', '500 м', '1 000 м', '1 500 м', '150 м']) expect(n).toContain(s);
  });

  it('опознаёт места-лежбища по названию', () => {
    for (const n of ['Лежбище сивучей', 'Моржовое лежбище', 'Залив Калана', 'Остров Топорков (сивуч)']) {
      expect(isMarineMammalPlace(n), n).toBe(true);
    }
  });

  it('не опознаёт чужие места и пустоту', () => {
    for (const n of ['Вулкан Авачинский', 'Паратунка', 'Долина гейзеров', '', null, undefined]) {
      expect(isMarineMammalPlace(n), String(n)).toBe(false);
    }
  });

  it('ответ get_guardian_context добавляет справку только при сильном совпадении и морском имени', () => {
    const src = read('lib/kuzmich/guardian-context.ts');
    expect(src).toMatch(
      /gradePlaceMatch\(placeName, p\.name, p\.aliases\) === 'high' && isMarineMammalPlace\(p\.name\)[\s\S]{0,80}marineMammalNote\(\)/,
    );
  });

  it('страница безопасности берёт числа из модуля, а не пишет свои', () => {
    const block = read('components/safety/MarineMammalRules.tsx');
    expect(block).toContain("from '@/lib/safety/marine-mammals'");
    expect(block).toContain('MARINE_DISTANCES.map');
    expect(block).toContain('MARINE_PROHIBITIONS.map');
    expect(block).not.toMatch(/\b(1500|1 500|1000|1 000)\b/);
    expect(read('app/safety/page.tsx')).toContain('<MarineMammalRules />');
    expect(read('app/safety/_SafetyClient.tsx')).toContain('{rules}');
  });
});
