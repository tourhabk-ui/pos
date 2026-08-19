/**
 * Свежесть дат в get_tours (аудит пилота 15.08).
 *
 * Каталог Кузьмича/MCP показывал «Ближайшая дата: 1 июня» в середине
 * августа: даты и места брались из СТАТИЧЕСКИХ колонок operator_tours
 * (next_available_date, available_slots), которые никто не обновляет.
 * Агент, процитировавший прошедшую дату, хуже агента без даты — свежесть
 * данных прямо названа требованием в MCP-оценке 15.08.
 *
 * Теперь ближайшая дата и места — из ЖИВОЙ tour_availability: слот не
 * раньше сегодня, не отменён, со свободными местами. Тот же источник, что
 * у get_tour_availability и гейта заявки на бронь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');

describe('get_tours: даты из живой занятости', () => {
  const block = CORE.slice(
    CORE.indexOf('SELECT ot.id, ot.title, ot.base_price'),
    CORE.indexOf('ORDER BY ot.base_price'),
  );

  it('ближайшая дата — из tour_availability, не из статической колонки', () => {
    expect(block).toMatch(/FROM tour_availability ta/);
    expect(block).toMatch(/ta\.date >= CURRENT_DATE/);
    expect(block).toMatch(/COALESCE\(ta\.is_cancelled, false\) = false/);
    expect(block).not.toMatch(/ot\.next_available_date/);
  });

  it('места — свободные на этот слот, не статический счётчик тура', () => {
    expect(block).toMatch(/ta\.available_slots - COALESCE\(ta\.booked_slots, 0\)/);
    expect(block).not.toMatch(/ot\.available_slots/);
  });

  it('нет слотов впереди — честный ноль, а не прошлогодняя дата', () => {
    expect(block).toMatch(/COALESCE\(live\.free_slots, 0\) AS available_slots/);
    expect(block).toMatch(/live\.next_date::text AS next_available_date/);
  });
});
