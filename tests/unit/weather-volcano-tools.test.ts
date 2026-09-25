/**
 * Сторож двух инструментов Кузьмича и MCP (25.09): погода по месту или
 * координатам и вулканы по двум шкалам.
 *
 * Повод — сверка владельца: у `get_weather` схема была пустой, описание
 * обещало только Петропавловск-Камчатский (а английское в MCP — «place or
 * coordinates», которых не было), и своего инструмента вулканов не было.
 *
 * Держится поведение: что спрошено — то и отвечено, отказ назван словами,
 * «повышенных нет» говорится только при свежих обеих шкалах.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
const forecast = vi.fn();
vi.mock('@/lib/planner/intelligence', () => ({ fetchForecastDays: (...a: unknown[]) => forecast(...a) }));

import { pool } from '@/lib/db-pool';
import { weatherTarget, parseDays, forecastLine, weatherForKuzmich } from '@/lib/kuzmich/weather-tool';
import { composeVolcanoReport, type VolcanoInput } from '@/lib/kuzmich/volcano-tool';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
const DAY = { date: '2026-09-26', tempMax: 9.4, tempMin: -1.2, precipMm: 3.1, windKmh: 42.6, weatherCode: 3, description: 'пасмурно' };

describe('get_weather: что спрошено', () => {
  it('координаты главнее имени', () => {
    const t = weatherTarget({ place: 'Мутновский', lat: '52.45', lng: '158,19' });
    expect(t).toMatchObject({ kind: 'point', lat: 52.45, lng: 158.19, outsideKrai: false });
  });

  it('одна координата без второй — отказ словами, а не подстановка города', () => {
    const t = weatherTarget({ lat: '52.45' });
    expect(t.kind).toBe('invalid');
  });

  it('координаты вне диапазона и не-числа — отказ', () => {
    expect(weatherTarget({ lat: '95', lng: '158' }).kind).toBe('invalid');
    expect(weatherTarget({ lat: 'север', lng: '158' }).kind).toBe('invalid');
  });

  it('точка вне края — прогноз даётся, но это сказано', () => {
    expect(weatherTarget({ lat: '55.75', lng: '37.62' })).toMatchObject({ kind: 'point', outsideKrai: true });
  });

  it('дни: по умолчанию 3, не больше 7', () => {
    expect(parseDays(undefined)).toBe(3);
    expect(parseDays('10')).toBe(7);
    expect(parseDays('0')).toBe(3);
  });

  it('пропуск в прогнозе — «нет данных», а не ноль', () => {
    const line = forecastLine({ ...DAY, windKmh: null, precipMm: null });
    expect(line).toContain('ветер — нет данных');
    expect(line).toContain('осадки — нет данных');
    expect(line).not.toMatch(/ветер до 0/);
  });
});

describe('get_weather: исполнитель', () => {
  beforeEach(() => { q.mockReset(); forecast.mockReset(); });

  it('по координатам прогноз берётся для ЭТОЙ точки, справочник не спрашивается', async () => {
    forecast.mockResolvedValueOnce({ ok: true, days: [DAY] });
    const out = await weatherForKuzmich({ lat: '52.45', lng: '158.19', days: '2' });
    expect(forecast).toHaveBeenCalledWith(52.45, 158.19, 2);
    expect(q).not.toHaveBeenCalled();
    expect(out).toContain('точка 52.4500, 158.1900');
    expect(out).toContain('26.09: -1…+9°C');
  });

  it('место из справочника — его координаты', async () => {
    q.mockResolvedValueOnce({ rows: [{ name: 'Вулкан Мутновский', lat: 52.45, lng: 158.19 }] });
    forecast.mockResolvedValueOnce({ ok: true, days: [DAY] });
    const out = await weatherForKuzmich({ place: 'Мутновский' });
    expect(forecast).toHaveBeenCalledWith(52.45, 158.19, 3);
    expect(out).toContain('«Вулкан Мутновский»');
  });

  it('места нет — так и сказано, город не подставлен', async () => {
    q.mockResolvedValueOnce({ rows: [] });
    const out = await weatherForKuzmich({ place: 'Нигдейка' });
    expect(out).toContain('нет в справочнике');
    expect(forecast).not.toHaveBeenCalled();
  });

  it('прогноз не пришёл — «не смог», а не погода', async () => {
    forecast.mockResolvedValueOnce({ ok: false, reason: 'Open-Meteo HTTP 503' });
    const out = await weatherForKuzmich({});
    expect(out).toMatch(/^ПОГОДА НЕДОСТУПНА/);
    expect(out).toContain('Open-Meteo HTTP 503');
  });

  it('схема и описание обещают ровно то, что исполняется', () => {
    const def = TOOL_REGISTRY.get_weather.definition.function;
    expect(Object.keys(def.parameters.properties)).toEqual(['place', 'lat', 'lng', 'days']);
    expect(def.description).not.toMatch(/^Получить текущую погоду в Петропавловске/);
  });
});

const NOW = Date.parse('2026-09-25T06:00:00Z');
const FRESH: VolcanoInput = {
  kvert: [
    { ark: 'a1', place_name: 'Вулкан Ключевской', name: 'Klyuchevskoy', acc: 'orange', ash_height_m: 6000, observed_at: '2026-09-25T01:00:00Z' },
    { ark: 'a2', place_name: 'Вулкан Мутновский', name: 'Mutnovsky', acc: 'green', ash_height_m: null, observed_at: '2026-09-24T20:00:00Z' },
    { ark: null, place_name: null, name: 'Karymsky', acc: 'green', ash_height_m: null, observed_at: '2026-09-24T20:00:00Z' },
  ],
  kfegsDate: '2026-09-24',
  kfegs: [
    { ark: 'a2', place_name: 'Вулкан Мутновский', name: 'Мутновский', name_en: 'Mutnovsky', color: 'yellow', raw: 'Ж', seismicity: 'Сейсмичность выше фона, событий 255.' },
    { ark: 'a1', place_name: 'Вулкан Ключевской', name: 'Ключевской', name_en: 'Klyuchevskoy', color: 'orange', raw: 'О', seismicity: null },
  ],
};

describe('get_volcano_status: две шкалы, победителя нет', () => {
  it('без имени — повышенные по ЛЮБОЙ шкале, обе шкалы в строке', () => {
    const out = composeVolcanoReport(FRESH, undefined, NOW);
    expect(out).toContain('Повышенная активность хотя бы по одной шкале — 2');
    // Мутновский зелёный по KVERT, жёлтый по КФ ЕГС — случай 22.09.
    expect(out).toMatch(/Вулкан Мутновский: КФ ЕГС[^\n]*жёлтый[^\n]*KVERT \(авиация\): зелёный/);
    expect(out).toMatch(/пепел до 6\.0 км/);
    expect(out).not.toContain('Karymsky');
  });

  it('дата сводки в шапке та же, что в строках (приёмка 25.09: шапка убегала на сутки)', () => {
    const out = composeVolcanoReport(FRESH, undefined, NOW);
    expect(out).toContain('КФ ЕГС: сводка за 24.09.2026');
    expect(out).toContain('за 24.09)');
  });

  it('вулкан вне свежей сводки — «в сводке нет», а не «сводки нет»', () => {
    const withKuril: VolcanoInput = {
      ...FRESH,
      kvert: [...FRESH.kvert!, { ark: null, place_name: null, name: 'CHIKURACHKI', acc: 'orange', ash_height_m: null, observed_at: '2026-09-25T01:00:00Z' }],
    };
    const out = composeVolcanoReport(withKuril, undefined, NOW);
    expect(out).toMatch(/CHIKURACHKI: КФ ЕГС: в сводке этого вулкана нет/);
    expect(out).not.toMatch(/CHIKURACHKI: КФ ЕГС: свежей сводки нет/);
  });

  it('самые опасные первыми', () => {
    const out = composeVolcanoReport(FRESH, undefined, NOW);
    expect(out.indexOf('Ключевской')).toBeLessThan(out.indexOf('Мутновский'));
  });

  it('по имени — этот вулкан по обеим шкалам, в том числе спокойный', () => {
    const out = composeVolcanoReport(FRESH, 'Карымский', NOW);
    // KVERT знает его по-английски, справочник — нет: русский запрос его не
    // найдёт, и это сказано словами, а не «спокоен».
    expect(out).toContain('нет в сводках');
    expect(out).toContain('НЕ значит, что он спокоен');
    const kl = composeVolcanoReport(FRESH, 'ключевской', NOW);
    expect(kl).toContain('Вулкан Ключевской: КФ ЕГС');
  });

  it('устаревшая сводка КФ ЕГС — её цвета не учтены, и «все спокойны» не говорится', () => {
    const stale: VolcanoInput = { ...FRESH, kfegsDate: '2026-09-20' };
    const calm: VolcanoInput = { ...stale, kvert: FRESH.kvert!.filter((k) => k.acc === 'green') };
    const out = composeVolcanoReport(calm, undefined, NOW);
    expect(out).toContain('устарела');
    expect(out).not.toContain('Повышенной активности нет ни по одной шкале');
    expect(out).toContain('это не «все вулканы спокойны»');
  });

  it('источник не прочитан — сказано, какой', () => {
    const out = composeVolcanoReport({ ...FRESH, kvert: null }, undefined, NOW);
    expect(out).toContain('KVERT: не смог прочитать');
    expect(out).toContain('Не все источники проверены');
  });

  it('обе шкалы свежие и зелёные — только тогда «нет ни по одной»', () => {
    const calm: VolcanoInput = {
      kvert: [FRESH.kvert![1]],
      kfegsDate: '2026-09-24',
      kfegs: [{ ...FRESH.kfegs![0], color: 'green' }],
    };
    expect(composeVolcanoReport(calm, undefined, NOW)).toContain('Повышенной активности нет ни по одной шкале');
  });
});
