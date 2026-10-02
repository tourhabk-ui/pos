/**
 * Сторож: сбой своей карты на /map виден, а не накрыт плашкой тревог.
 *
 * Скрин владельца 03.10 11:29 (4G): карта без подложки, а строка
 * «Своя карта не отрисовалась… — качаем заново» стоит в углу карты под
 * колонкой тревог (z-500) и читается обрывками. Тот же урок, что на полевом
 * экране 01.09: строку носит VedarMap.onDiagnostic в колонку над картой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/map/_MapPageClient.tsx'), 'utf-8');

describe('/map: отчёт карты о себе — в колонке тревог', () => {
  it('страница принимает отчёт своей карты', () => {
    expect(SRC).toMatch(/onDiagnostic=\{setMapDiag\}/);
  });

  it('и рисует его в той же колонке, что и плашку тревог', () => {
    const col = SRC.slice(SRC.indexOf('<MapThreatChip />'), SRC.indexOf('{quakesMode && quakeHit'));
    expect(col).toMatch(/\{mapDiag && \(/);
    expect(col).toMatch(/role="status"/);
  });
});
