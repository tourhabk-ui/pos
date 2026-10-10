/**
 * Сторож: две цены «Кутхи» (миграция 1205, слово хозяина дома 10.10:
 * «8 спальных мест 24 т.р., плюс 2 раскладушки 28 т.р. Баня включена.»).
 *
 * Держит: нижняя цена — в price_per_night_from, верхняя — в _to, обе только
 * поверх значений 1198; места — 8 и 2 раскладушки (10, а не 12 из 1204);
 * тексты переписываются только поверх 1204; без «все даты свободны».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'migrations/1205_kutha_two_prices.sql'), 'utf8');
const CODE = SQL.replace(/--[^\n]*/g, '');

describe('миграция 1205: две цены «Кутхи»', () => {
  it('24 000 — нижняя, 28 000 — верхняя, только поверх 1198', () => {
    expect(CODE).toMatch(/SET price_per_night_from = 24000,\s+price_per_night_to = 28000/);
    expect(CODE).toMatch(/AND price_per_night_from = 28000\s+AND price_per_night_to IS NULL/);
  });

  it('8 спальных мест и 2 раскладушки, до 10 человек; баня в цене', () => {
    expect(CODE).toMatch(/8 спальных мест и ещё 2 раскладушки, до 10 человек/);
    expect(CODE).toMatch(/24 000 ₽ на 8 спальных мест, 28 000 ₽ с двумя раскладушками/);
    expect(CODE).toMatch(/Баня входит в цену/);
    expect(CODE).not.toMatch(/до 12 человек'/);
    expect(CODE).not.toMatch(/все даты свободны/i);
  });

  it('тексты — только поверх 1204, правка администратора цела', () => {
    expect(CODE).toMatch(/description LIKE '%до 12 человек%'/);
    expect(CODE).toMatch(/short_description = 'Дом целиком до 12 человек: баня, крытый бассейн, пос\. Пионерский'/);
  });
});
