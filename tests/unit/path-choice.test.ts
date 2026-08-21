/**
 * Выбор пути от места (решение владельца 20.08): человек называет место,
 * платформа показывает пути к нему, сравнимые по роду линии и длине.
 *
 * Сторож держит три черты: снятый трек стоит выше любых догадок, внутри
 * рода сравнивает длина, а совпавшие только названием маршрута не выдаются
 * за пути к месту — им отдельная честная секция.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comparePaths, groupRoutesByPlace } from '@/lib/routes/path-choice';

const R = (
  id: string, grade: string | null, km: number | null, wps: string[] = [],
  difficulty: string | null = null, elevationGainM: number | null = null,
) => ({ id, title: id, distanceKm: km, lineGrade: grade, waypointNames: wps, difficulty, elevationGainM });

describe('сравнение путей', () => {
  it('снятый трек выше догадок, даже если длиннее', () => {
    const surveyed = R('a', 'surveyed', 20);
    const unknown = R('b', 'unknown', 2);
    expect([unknown, surveyed].sort(comparePaths)[0].id).toBe('a');
  });

  it('внутри одного рода — короче выше', () => {
    const long = R('a', 'unknown', 10);
    const short = R('b', 'unknown', 3);
    expect([long, short].sort(comparePaths)[0].id).toBe('b');
  });

  it('без длины — в конец своего рода, а не наверх', () => {
    const noKm = R('a', 'unknown', null);
    const withKm = R('b', 'unknown', 42);
    expect([noKm, withKm].sort(comparePaths)[0].id).toBe('b');
  });

  it('внутри рода легче выше, даже если длиннее', () => {
    const hardShort = R('a', 'unknown', 2, [], 'hard');
    const easyLong = R('b', 'unknown', 12, [], 'easy');
    expect([hardShort, easyLong].sort(comparePaths)[0].id).toBe('b');
  });

  it('сложность не перебивает род линии: снятый hard выше догадки easy', () => {
    const surveyedHard = R('a', 'surveyed', 8, [], 'hard');
    const unknownEasy = R('b', 'unknown', 3, [], 'easy');
    expect([unknownEasy, surveyedHard].sort(comparePaths)[0].id).toBe('a');
  });

  it('неуказанная сложность — середина: ниже easy, выше hard', () => {
    const unknown = R('a', 'unknown', 5, [], null);
    const easy = R('b', 'unknown', 5, [], 'easy');
    const hard = R('c', 'unknown', 5, [], 'hard');
    const order = [hard, unknown, easy].sort(comparePaths).map(r => r.id);
    expect(order).toEqual(['b', 'a', 'c']);
  });

  it('при прочих равных меньший набор высоты выше, неизвестный — после известного', () => {
    const big = R('a', 'unknown', 5, [], 'easy', 900);
    const small = R('b', 'unknown', 5, [], 'easy', 200);
    const none = R('c', 'unknown', 5, [], 'easy', null);
    expect([none, big, small].sort(comparePaths).map(r => r.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('группировка по месту', () => {
  it('четвёрка Трёх Братьев собирается под одним местом', () => {
    const routes = [
      R('вечерняя', 'unknown', null, ['Скалы Три Брата']),
      R('к-скалам', 'points_only', 1, ['Скалы Три Брата']),
      R('скалы', 'surveyed', 1.6, ['Скалы Три Брата']),
      R('смотровая', 'unknown', null, ['Скалы Три Брата']),
    ];
    const groups = groupRoutesByPlace(routes, 'три брата');
    expect(groups).toHaveLength(1);
    expect(groups[0].place).toBe('Скалы Три Брата');
    expect(groups[0].routes[0].id).toBe('скалы');
  });

  it('ё и регистр не мешают месту найтись', () => {
    const routes = [R('a', 'unknown', 5, ['Голубые озёра'])];
    expect(groupRoutesByPlace(routes, 'голубые озера')[0].place).toBe('Голубые озёра');
  });

  it('совпавшие только названием — отдельной секцией в конце', () => {
    const routes = [
      R('через-место', 'unknown', 5, ['Скалы Три Брата']),
      R('только-именем', 'surveyed', 1, []),
    ];
    const groups = groupRoutesByPlace(routes, 'три');
    expect(groups).toHaveLength(2);
    expect(groups[0].place).toBe('Скалы Три Брата');
    expect(groups[1].place).toBe(null);
  });
});

describe('пикер поля выбирает от места', () => {
  it('«Куда идём?» группирует выдачу правилом из lib, а не плоским списком', () => {
    const src = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    expect(src).toContain("from '@/lib/routes/path-choice'");
    expect(src).toContain('groupRoutesByPlace(searchRoutes');
  });
});
