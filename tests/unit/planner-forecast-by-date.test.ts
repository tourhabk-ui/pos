/**
 * Погода к дням плана — по дате приезда, а не по номеру от сегодня (25.09).
 *
 * Было: `lib/planner/engine.ts` брал прогноз от СЕГОДНЯ и клал `forecasts[day - 1]`
 * в день плана, хотя у профиля есть `arrivalDate`. При приезде через неделю
 * первый день получал сегодняшнюю погоду, и она уходила в промпт планера.
 * `lib/planner/compose.ts` делал то же для поездки, у которой известен только
 * месяц, после отдачи ответа, и писал `planB`, который никто не читал.
 *
 * Сторож держит:
 * 1. окно прогноза считается от даты приезда в поясе Камчатки;
 * 2. поездка за 16 днями прогноза или в прошлом — погоды нет, а не чужая;
 * 3. engine ищет день по дате через честный загрузчик;
 * 4. погодного «Плана Б» в compose нет, старого загрузчика с нулями нет нигде.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tripForecastWindow } from '@/lib/planner/intelligence';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

// 25.09 14:00 UTC — на Камчатке (UTC+12) уже 26.09.
const NOW = new Date('2026-09-25T14:00:00Z');

describe('окно прогноза поездки', () => {
  it('приезд через неделю: день 1 — дата приезда, а не сегодня', () => {
    const w = tripForecastWindow('2026-10-03', 3, NOW)!;
    expect(w.dates).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
    // Сегодня на Камчатке 26.09: до 05.10 — девять дней, горизонт десять.
    expect(w.horizon).toBe(10);
  });

  it('«сегодня» — по Камчатке: в 14:00 UTC там уже завтра', () => {
    const w = tripForecastWindow('2026-09-26', 1, NOW)!;
    expect(w.horizon).toBe(1);
  });

  it('поездка целиком за 16 днями прогноза — погоды нет', () => {
    expect(tripForecastWindow('2026-10-20', 5, NOW)).toBeNull();
  });

  it('поездка в прошлом — погоды нет; частично в горизонте — горизонт до 16', () => {
    expect(tripForecastWindow('2026-09-01', 3, NOW)).toBeNull();
    expect(tripForecastWindow('2026-10-08', 10, NOW)!.horizon).toBe(16);
  });

  it('дата не читается — погоды нет', () => {
    expect(tripForecastWindow('скоро', 3, NOW)).toBeNull();
    expect(tripForecastWindow('2026-10-03', 0, NOW)).toBeNull();
  });
});

describe('подключено', () => {
  it('engine ищет день плана по дате через честный загрузчик', () => {
    const src = read('lib/planner/engine.ts');
    expect(src).toContain('tripForecastWindow(profile.arrivalDate');
    expect(src).toContain('forecast.days.find((f) => f.date === date)');
    expect(src).not.toMatch(/forecasts\[idx\]|forecasts\[day\.day - 1\]/);
  });

  it('в compose нет погодного «Плана Б» от сегодняшнего прогноза', () => {
    const src = read('lib/planner/compose.ts');
    expect(src).not.toMatch(/addWeatherPlanB|planBReason|forecast\[dayIndex\]/);
  });

  it('загрузчика с нулями вместо пропусков больше нет нигде', () => {
    const hits = execSync(
      "grep -rln 'fetchWeatherForecast' app lib components --include=*.ts --include=*.tsx || true",
      { encoding: 'utf-8' },
    ).trim();
    expect(hits).toBe('');
  });
});
