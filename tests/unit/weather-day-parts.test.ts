/**
 * #2249: прогноз по частям дня и тип осадков только при уверенном сигнале.
 *
 * 08.10 суточный код подписал ясное утро в Петропавловске «снегопадом», 06.10
 * морось — «сильным ливнем»; посты в канал правились руками. Сторож держит:
 * части дня строятся из почасового ряда, слово «снег»/«дождь» звучит только
 * при уверенном сигнале, а суточная подпись осадков при частях не показывается
 * ни в get_weather, ни в утренней сводке.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDayParts, dayPartsPhrase, keepDailyDescription, precipWords, type DayPart,
} from '@/lib/weather/day-parts';
import { forecastLine, settlementByName } from '@/lib/kuzmich/weather-tool';
import { weatherPhrase } from '@/lib/svodka/svodka';
import type { ForecastDay } from '@/lib/planner/intelligence';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

function hourly(date: string, perHour: (h: number) => { t: number; p: number; s: number; w: number }) {
  const time: string[] = []; const t: number[] = []; const p: number[] = []; const s: number[] = []; const w: number[] = [];
  for (let h = 0; h < 24; h++) {
    const v = perHour(h);
    time.push(`${date}T${String(h).padStart(2, '0')}:00`);
    t.push(v.t); p.push(v.p); s.push(v.s); w.push(v.w);
  }
  return { time, temperature_2m: t, precipitation: p, snowfall: s, wind_speed_10m: w };
}

const part = (o: Partial<DayPart>): DayPart => ({
  label: 'день', precipMm: 0, snowCm: 0, tempMin: 5, tempMax: 8, windKmh: 10, ...o,
});

describe('части дня из почасового ряда', () => {
  it('случай 08.10: снег только к вечеру — утро сухое, вечер «снег»', () => {
    const parts = buildDayParts(
      hourly('2026-10-08', (h) => (h >= 18 ? { t: -1, p: 0.6, s: 0.4, w: 15 } : { t: 4, p: 0, s: 0, w: 8 })),
      '2026-10-08',
    );
    expect(parts.map((p) => p.label)).toEqual(['ночь', 'утро', 'день', 'вечер']);
    expect(precipWords(parts[1])).toBe('без осадков');
    expect(precipWords(parts[3])).toBe('снег 3.6 мм');
    expect(dayPartsPhrase(parts)).toBe('ночь без осадков · утро без осадков · день без осадков · вечер снег 3.6 мм');
  });

  it('чужая дата и пустой ряд — частей нет, остаётся суточная строка', () => {
    expect(buildDayParts(hourly('2026-10-09', () => ({ t: 1, p: 0, s: 0, w: 1 })), '2026-10-08')).toEqual([]);
    expect(buildDayParts(undefined, '2026-10-08')).toEqual([]);
  });

  it('пропуски в ряду — «нет данных», а не ноль', () => {
    const parts = buildDayParts({ time: ['2026-10-08T07:00'], temperature_2m: [null], precipitation: [null] }, '2026-10-08');
    expect(precipWords(parts[1])).toBe('осадки — нет данных');
  });
});

describe('тип осадков — только при уверенном сигнале', () => {
  it('снег: снегопад есть и не теплее +1°', () => {
    expect(precipWords(part({ precipMm: 2, snowCm: 1.5, tempMin: -2, tempMax: 1 }))).toBe('снег 2 мм');
  });
  it('снегопад при +3° — не «снег», а нейтрально', () => {
    expect(precipWords(part({ precipMm: 2, snowCm: 0.3, tempMin: 1, tempMax: 3 }))).toBe('осадки 2 мм');
  });
  it('дождь: снегопада нет и не холоднее +2°', () => {
    expect(precipWords(part({ precipMm: 4, snowCm: 0, tempMin: 3, tempMax: 6 }))).toBe('дождь 4 мм');
  });
  it('около нуля без снегопада и снег не отдан моделью — нейтрально', () => {
    expect(precipWords(part({ precipMm: 1, snowCm: 0, tempMin: 0, tempMax: 2 }))).toBe('осадки 1 мм');
    expect(precipWords(part({ precipMm: 1, snowCm: null, tempMin: 5, tempMax: 7 }))).toBe('осадки 1 мм');
  });
  it('меньше 0,1 мм — без осадков', () => {
    expect(precipWords(part({ precipMm: 0.05 }))).toBe('без осадков');
  });
});

describe('суточная подпись осадков при частях не показывается', () => {
  const day: ForecastDay = {
    date: '2026-10-08', tempMin: -1, tempMax: 4, precipMm: 3.8, windKmh: 15,
    weatherCode: 73, description: 'Снегопад',
    parts: [part({ label: 'утро', precipMm: 0 }), part({ label: 'вечер', precipMm: 3.8, snowCm: 2, tempMin: -1, tempMax: 0 })],
  };

  it('правило: осадки (51–86) прячутся, ясно/туман и гроза остаются', () => {
    expect(keepDailyDescription(73, true)).toBe(false);
    expect(keepDailyDescription(61, true)).toBe(false);
    expect(keepDailyDescription(3, true)).toBe(true);
    expect(keepDailyDescription(95, true)).toBe(true);
    expect(keepDailyDescription(73, false)).toBe(true);
  });

  it('get_weather: «Снегопад» на весь день не пишется, части — пишутся', () => {
    const line = forecastLine(day);
    expect(line).not.toMatch(/Снегопад/);
    expect(line).toMatch(/утро без осадков · вечер снег 3.8 мм/);
  });

  it('сводка (посты в канал): то же правило', () => {
    const phrase = weatherPhrase(day);
    expect(phrase).not.toMatch(/снегопад/);
    expect(phrase).toMatch(/вечер снег 3.8 мм/);
  });

  it('без частей — прежняя суточная строка', () => {
    expect(forecastLine({ ...day, parts: [] })).toMatch(/Снегопад/);
  });

  it('запрос Open-Meteo просит почасовой ряд со снегопадом', () => {
    expect(read('lib/planner/intelligence.ts')).toMatch(/hourly=temperature_2m,precipitation,snowfall,wind_speed_10m/);
  });
});

describe('посёлки, которых нет в каталоге мест', () => {
  it.each([
    ['Ключи', 'Ключи'], ['п. Ключи', 'Ключи'], ['в Ключах', null], ['Ключах', 'Ключи'],
    ['Усть-Камчатск', 'Усть-Камчатск'], ['Соболево', 'Соболево'], ['пгт Палана', 'Палана'],
    // Эссо — село, а не «Вид на Эссо» каталога (смотровая на ~1430 м, проба 724).
    ['Эссо', 'Эссо'], ['с. Эссо', 'Эссо'],
  ])('%s → %s', (q, expected) => {
    expect(settlementByName(q)?.name ?? null).toBe(expected);
  });

  it('вулкан не путается с посёлком', () => {
    expect(settlementByName('Ключевская сопка')).toBeNull();
    expect(settlementByName('Ключевская')).toBeNull();
  });
});
