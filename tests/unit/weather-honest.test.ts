/**
 * /api/weather не выдумывает погоду (#1774, §4.0).
 *
 * До 10.09 при отказе всех провайдеров роут отдавал success:true с 15 °C,
 * ветром 10, влажностью 60 % и видимостью 10 км — и safetyLevel «good».
 * Дашборды рисовали это как замер, а турист получал оценку условий, взятую
 * из воздуха. Отдельно: Open-Meteo «не даёт» видимость и дневную влажность —
 * на самом деле даёт почасовые ряды, из которых обе выводятся; там, где их
 * нет, поле обязано быть null, и тип обязан это позволять.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const route = read('app/api/weather/route.ts');
const types = read('types/index.ts');

describe('роут погоды', () => {
  it('отказ провайдеров — success:false и 503, а не выдуманные значения', () => {
    expect(route).not.toMatch(/getDefaultWeather/);
    expect(route).toMatch(/unavailable:\s*true/);
    expect(route).toMatch(/status:\s*503/);
    expect(route).toMatch(/Promise<Weather \| null>/);
  });

  it('отказ каждого провайдера пишется в лог с его именем', () => {
    expect(route).toMatch(/console\.error\('\[weather\][^']*',\s*\{\s*provider/s);
  });

  it('констант-заглушек влажности и видимости нет', () => {
    // Литерал «humidity: 60» / «visibility: 10» — это и была подмена данных.
    expect(route).not.toMatch(/humidity:\s*60\b/);
    expect(route).not.toMatch(/visibility:\s*10\b/);
    expect(route).not.toMatch(/visibility \|\| 10/);
    expect(route).not.toMatch(/temperature:\s*15\b/);
  });

  it('видимость и дневная влажность Open-Meteo берутся из почасовых рядов', () => {
    expect(route).toMatch(/hourlyVisibilityKm\(hourly\.time, hourly\.visibility, current\.time\)/);
    expect(route).toMatch(/meanHourlyForDate\(hourly\.time, hourly\.relative_humidity_2m/);
  });

  it('пороги видимости не срабатывают при неизвестной видимости', () => {
    expect(route).toMatch(/visibility: number \| null/);
    expect(route).toMatch(/visibility \?\? Number\.POSITIVE_INFINITY/);
  });
});

describe('тип Weather допускает отсутствие', () => {
  it('humidity и visibility — number | null', () => {
    const block = types.slice(types.indexOf('export interface Weather {'), types.indexOf('export interface WeatherForecast'));
    expect(block).toMatch(/humidity: number \| null;/);
    expect(block).toMatch(/visibility: number \| null;/);
  });

  it('потребители не печатают «null%»', () => {
    for (const p of ['app/hub/tourist/_TouristDashboardClient.tsx', 'app/hub/guide/_GuideDashboardClient.tsx']) {
      const src = read(p);
      expect(src, p).not.toMatch(/>\{weather\.humidity\}%</);
      expect(src, p).not.toMatch(/>\{weather\.visibility\}[ <]/);
    }
  });

  it('кабинет туриста показывает отказ погоды, а не пустое место', () => {
    const src = read('app/hub/tourist/_TouristDashboardClient.tsx');
    expect(src).toMatch(/weatherFailed/);
    expect(src).toMatch(/нет данных/i);
  });
});
