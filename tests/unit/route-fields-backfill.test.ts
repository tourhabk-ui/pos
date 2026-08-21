/**
 * Бэкфилл полей маршрута — из своих данных, только в пустое, со следом.
 *
 * Проба 123: без сложности 304 живых из 393, без дистанции 192, без типа
 * активности 270. «Го» владельца 21.08 на заполнение из данных и на пороги
 * шкалы. Сторож держит черты, которые нельзя потерять правкой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeDifficulty, DIFFICULTY_SCALE } from '@/lib/routes/difficulty-scale';

const src = readFileSync(
  join(process.cwd(), 'app/api/cron/route-fields-backfill/route.ts'), 'utf-8',
);

describe('шкала сложности — утверждённые пороги, каскад по обоим числам', () => {
  it('пороги ровно те, на которые дано «го»', () => {
    expect(DIFFICULTY_SCALE).toEqual([
      { level: 'easy', maxGainM: 400, maxKm: 10 },
      { level: 'medium', maxGainM: 1000, maxKm: 25 },
      { level: 'hard', maxGainM: 2000, maxKm: 50 },
    ]);
  });

  it('короткий, но крутой — не easy: судят оба числа', () => {
    expect(computeDifficulty(1859, 14)).toBe('hard');
    expect(computeDifficulty(34, 1.6)).toBe('easy');
    expect(computeDifficulty(500, 8)).toBe('medium');
    expect(computeDifficulty(2600, 12)).toBe('extreme');
    expect(computeDifficulty(300, 60)).toBe('extreme');
  });
});

describe('актуатор полей', () => {
  it('дистанция не меряется по наброску прямыми', () => {
    expect(src).toContain("<> 'waypoints_synthetic'");
  });

  it('каждый шаг пишет только в пустое', () => {
    expect(src).toMatch(/UPDATE kamchatka_routes[\s\S]{0,400}r\.distance_km IS NULL/);
    expect(src).toMatch(/UPDATE kamchatka_routes[\s\S]{0,400}COALESCE\(r\.difficulty, ''\) = ''/);
    expect(src).toMatch(/UPDATE kamchatka_routes[\s\S]{0,400}COALESCE\(r\.activity_type, ''\) = ''/);
  });

  it('вычисленная сложность несёт след происхождения', () => {
    expect(src).toContain("difficulty_source = 'computed_v1'");
  });

  it('активность не выдумывает новых слов номенклатуре', () => {
    expect(src).toContain('known.has(rule.value)');
  });

  it('«поход на каяках» треккингом не становится', () => {
    expect(src).toContain('NOT_ON_FOOT_RE');
  });
});
