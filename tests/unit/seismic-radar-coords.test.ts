// @vitest-environment node
/**
 * Радар без точек при живой ленте (24.09).
 *
 * Проба 572: /api/safety/seismic отдала три толчка за 48 часов — все без
 * lat/lng, радар пуст. Координата лежала в тексте EQKam, но в колонки до 24.09
 * не писалась; USGS спрашивался с порогом M5, а смена EQKam — таблица emsd.ru —
 * на проде не разобралась (проба 573). Держится: USGS видит M4, а миграция
 * переносит в колонки ТОЛЬКО то, что записано в тексте, и только внутри края.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PARSER = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
const MIG = readFileSync(join(process.cwd(), 'migrations/1011_quake_coords_from_text.sql'), 'utf-8')
  .replace(/--[^\n]*/g, '');

describe('USGS видит диапазон M4', () => {
  it('порог minmagnitude не выше 4.0', () => {
    const m = PARSER.match(/earthquake\.usgs\.gov\/fdsnws[\s\S]{0,200}?minmagnitude=([\d.]+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(4.0);
  });

  it('USGS пишет через saveQuakeOnce — пересечение с emsd.ru гасится по физике', () => {
    const i = PARSER.indexOf('export async function ingestUsgs(');
    const body = PARSER.slice(i, PARSER.indexOf('\n}\n', i));
    expect(body).toContain('saveQuakeOnce(event)');
  });
});

describe('миграция 1011 не выдумывает координат', () => {
  it('трогает только землетрясения с ОБЕИМИ пустыми координатами', () => {
    expect(MIG).toMatch(/alert_type = 'earthquake'/);
    expect(MIG).toMatch(/lat IS NULL\s+AND lng IS NULL/);
  });

  it('берёт числа из той же формы, что парсер EQKam', () => {
    expect(MIG).toContain('Координаты:');
    expect(PARSER).toMatch(/Координаты:\\s\*/);
  });

  it('точка вне края не пишется', () => {
    expect(MIG).toMatch(/\[1\]::numeric BETWEEN 45 AND 65/);
    expect(MIG).toMatch(/\[2\]::numeric BETWEEN 150 AND 175/);
  });
});
