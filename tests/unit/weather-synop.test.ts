/**
 * Осадки станции из SYNOP (#2249): факт для замера моделей погоды.
 *
 * Фикстура — настоящие сводки Петропавловска-Камчатского (WMO 32583) с
 * Ogimet за 01–08.10 (проба 721): 57 сроков, один NIL. Осадки станция
 * передаёт в 09 и 21 UTC суммой за 12 часов; 02.10 вечером — 49 мм.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSynopPrecip, synopDailyTotals, decodeRRR, modelOffsetForStationDay,
} from '@/lib/weather/synop';
import { dailySums } from '@/lib/weather/model-skill';

const FIXTURE = readFileSync(join(process.cwd(), 'tests/fixtures/ogimet-synop-32583-2026-10-01-08.txt'), 'utf8');

describe('decodeRRR (code table 3590)', () => {
  it('миллиметры, следы, десятые', () => {
    expect(decodeRRR('000')).toBe(0);
    expect(decodeRRR('049')).toBe(49);
    expect(decodeRRR('990')).toBe(0);
    expect(decodeRRR('993')).toBeCloseTo(0.3);
    expect(decodeRRR('///')).toBeNull();
  });
});

describe('parseSynopPrecip на сводках 32583', () => {
  const p = parseSynopPrecip(FIXTURE, '32583');

  it('сроки пересчитаны, NIL назван, а не принят за «сухо»', () => {
    expect(p.reports).toBe(57);
    expect(p.nil).toBe(1);
    expect(p.unparsed).toBe(0);
  });

  it('осадки — только в 09 и 21 UTC, по 12 часов; в прочие сроки iR=4 и группы нет', () => {
    expect(p.periods.length).toBe(14);
    expect(new Set(p.periods.map((x) => x.endUtc.slice(11)))).toEqual(new Set(['09:00', '21:00']));
    expect(p.periods.every((x) => x.hours === 12 && x.section === 1)).toBe(true);
  });

  it('02.10 21 UTC — 49 мм за 12 часов; «следы» — ноль', () => {
    expect(p.periods.find((x) => x.endUtc === '2026-10-02T21:00')?.mm).toBe(49);
    expect(p.periods.find((x) => x.endUtc === '2026-10-01T21:00')?.mm).toBe(0);
  });
});

describe('synopDailyTotals', () => {
  it('сутки станции — (D−1 21:00, D 21:00] UTC из двух половин', () => {
    const d = synopDailyTotals(parseSynopPrecip(FIXTURE, '32583').periods, 21);
    expect([...d.entries()]).toEqual([
      ['2026-10-01', 1],
      ['2026-10-02', 52],
      ['2026-10-03', 0],
      ['2026-10-04', 0],
      ['2026-10-05', 0],
      ['2026-10-06', 21],
      ['2026-10-07', 0],
    ]);
  });

  it('без любой из половин сутки не считаются — и не становятся сухими', () => {
    const d = synopDailyTotals([{ endUtc: '2026-10-02T21:00', hours: 12, mm: 0, section: 1 }], 21);
    expect(d.size).toBe(0);
  });

  it('суточная сумма за срок берётся целиком', () => {
    const d = synopDailyTotals([{ endUtc: '2026-10-02T21:00', hours: 24, mm: 7.5, section: 3 }], 21);
    expect(d.get('2026-10-02')).toBe(7.5);
  });

  it('противоречивые дубли одного периода — «не знаю»', () => {
    const d = synopDailyTotals([
      { endUtc: '2026-10-02T09:00', hours: 12, mm: 1, section: 1 },
      { endUtc: '2026-10-02T21:00', hours: 12, mm: 0, section: 1 },
      { endUtc: '2026-10-02T21:00', hours: 12, mm: 4, section: 1 },
    ], 21);
    expect(d.has('2026-10-02')).toBe(false);
  });
});

describe('окно модели совпадает с окном станции', () => {
  it('метка Open-Meteo — конец часа: для конца суток 21 UTC сдвиг +2', () => {
    expect(modelOffsetForStationDay(21)).toBe(2);
    // Часы, заканчивающиеся с 02.10 22:00 по 03.10 21:00 UTC, — это сутки
    // станции 03.10. Дождь в час, кончившийся в 21:00 02.10, принадлежит
    // суткам 02.10 и в 03.10 попасть не должен.
    const times: string[] = [];
    const values: number[] = [];
    for (let h = 0; h < 72; h++) {
      const t = new Date(Date.parse('2026-10-01T22:00Z') + h * 3_600_000).toISOString().slice(0, 16);
      times.push(t);
      values.push(t === '2026-10-02T21:00' ? 5 : 0);
    }
    const s = dailySums(times, values, modelOffsetForStationDay(21));
    expect(s.get('2026-10-02')).toBe(5);
    expect(s.get('2026-10-03')).toBe(0);
  });
});
