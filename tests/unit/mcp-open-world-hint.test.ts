/**
 * openWorldHint — факт об исполнении, а не пожелание (проверка MCP 29.09).
 *
 * make_trip_plan стоял закрытым, хотя движок плана в момент вызова берёт
 * прогноз Open-Meteo на даты поездки (engine → fetchForecastDays). Хост,
 * доверяющий подсказке, считал бы инструмент не выходящим наружу. Сторож
 * держит связку: инструмент, чей путь доходит до внешнего прогноза, помечен
 * открытым; исчезнет вызов — тест потребует пересмотреть пометку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/public-tools';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('инструменты, идущие наружу в момент вызова, помечены открытыми', () => {
  it('get_weather — прогноз Open-Meteo', () => {
    expect(read('lib/kuzmich/weather-tool.ts')).toMatch(/fetchForecastDays\(/);
    expect(TOOL_ANNOTATIONS.get_weather?.openWorldHint).toBe(true);
  });

  it('make_trip_plan — прогноз на даты плана через движок', () => {
    expect(read('lib/kuzmich/trip-plan-tool.ts')).toMatch(/recommendTrip\(/);
    expect(read('lib/planner/engine.ts')).toMatch(/await fetchForecastDays\(/);
    expect(TOOL_ANNOTATIONS.make_trip_plan?.openWorldHint).toBe(true);
  });
});
