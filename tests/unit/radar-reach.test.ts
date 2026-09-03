/**
 * Круг радара вмещает вулканы, ради которых он есть.
 *
 * 02.09 владелец прислал экран /safety: шесть точек, все — сейсмика,
 * вулканов ни одного, хотя утром того же дня их привязка к местам была
 * починена (#1497) и KVERT держал повышенные коды по Ключевскому,
 * Безымянному, Шивелучу и Крашенинникову. Радар центрируется на
 * Петропавловске, а эти вулканы стоят на 200-440 км севернее — при кольце
 * в 200 км слой был пуст ПО ПОСТРОЕНИЮ: не «данных нет», а «круг не
 * вмещает». Внутри 200 км оказывались только зелёные Авачинский и
 * Корякский, а зелёные на радар не идут.
 *
 * Координаты — справочные, с точностью до километров: сторож проверяет
 * порядок расстояния, не точку.
 */
import { describe, it, expect } from 'vitest';
import { RADAR_MAX_KM } from '@/components/safety/LiveStatus';
import { CULL_KM } from '@/lib/geo/coastline';

const PPK = { lat: 53.02, lng: 158.65 };
const KM_LAT = 111.32;

function distKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const kmLng = KM_LAT * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * KM_LAT, (b.lng - a.lng) * kmLng);
}

const VOLCANOES = {
  'Ключевской':     { lat: 56.056, lng: 160.642 },
  'Безымянный':     { lat: 55.972, lng: 160.595 },
  'Шивелуч':        { lat: 56.653, lng: 161.360 },
  'Крашенинников':  { lat: 54.593, lng: 160.273 },
  'Карымский':      { lat: 54.049, lng: 159.443 },
};

describe('радар от Петропавловска', () => {
  for (const [name, at] of Object.entries(VOLCANOES)) {
    it(`видит ${name} (${Math.round(distKm(PPK, at))} км)`, () => {
      expect(distKm(PPK, at)).toBeLessThan(RADAR_MAX_KM);
    });
  }

  it('при прежних 200 км Ключевская группа и Шивелуч не помещались — это и был экран владельца', () => {
    // Фиксируется причина, а не только починка: если кто-то вернёт 200,
    // тест выше упадёт, а этот объяснит, что именно сломалось.
    expect(distKm(PPK, VOLCANOES['Ключевской'])).toBeGreaterThan(200);
    expect(distKm(PPK, VOLCANOES['Шивелуч'])).toBeGreaterThan(200);
  });

  it('порог отсечения берега растёт вместе со скопом', () => {
    expect(CULL_KM).toBeGreaterThan(RADAR_MAX_KM);
  });
});
