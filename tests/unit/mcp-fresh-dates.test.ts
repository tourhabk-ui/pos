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

import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';

const CORE = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');

describe('get_tours: даты из живой занятости', () => {
  // Запрос каталога — от SELECT до шлюза витрины. С 29.10 порядка в SQL нет
  // (правило 1в считается после запроса, lib/tours/offer-order).
  const start = CORE.indexOf('SELECT ot.id, ot.title, ot.base_price');
  const block = CORE.slice(start, CORE.indexOf("WHERE ${publicTourSql('ot')}", start));
  // Ближайшая дата — одно условие на все витрины (lib/tours/nearest-free-date).
  const nearest = nearestFreeDateSql('ot');

  it('ближайшая дата — из tour_availability, не из статической колонки', () => {
    expect(start).toBeGreaterThan(0);
    expect(block).toContain("${nearestFreeDateSql('ot')}");
    expect(nearest).toMatch(/FROM tour_availability ta_nf/);
    // «Сегодня» — по Камчатке (проверка MCP 29.09), не по поясу сессии БД.
    expect(nearest).toMatch(/ta_nf\.date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)::date/);
    expect(nearest).not.toMatch(/CURRENT_DATE/);
    expect(block).not.toMatch(/CURRENT_DATE/);
    expect(nearest).toMatch(/COALESCE\(ta_nf\.is_cancelled, false\) = false/);
    expect(block).not.toMatch(/ot\.next_available_date/);
  });

  // Проверка MCP 29.09 (T6): тур без календаря печатался «Мест: нет
  // свободных» — агент не доходил до запроса мест оператору.
  it('«расписания нет» отличается от «мест нет»', () => {
    // Правило «ведёт расписание» — общее (lib/tours/schedule), а не своя
    // копия в SQL каталога: копий было две, третья понадобилась планеру.
    expect(block).toMatch(/\$\{keepsScheduleSql\('ot\.id'\)\} AS has_schedule/);
    expect(CORE).toMatch(/r\.has_schedule === false\s*\? ' \| Расписания в системе нет/);
  });

  it('места — свободные на этот слот, не статический счётчик тура', () => {
    // Слот — по-прежнему ta.*, но вычитается ЖИВАЯ занятость (общее правило
    // lib/bookings/occupancy), а не счётчик booked_slots: тот растёт только при
    // оплате (сверка «MCP против сайта» 29.09, tests/unit/occupancy-single-rule).
    expect(block).toMatch(/freeSlotsSql\('ta', 'ot', 'occ\.taken'\)/);
    expect(nearest).toContain('LEAST(ta_nf.available_slots, COALESCE(ot.max_participants, ta_nf.available_slots))');
    expect(block).not.toMatch(/ta\.booked_slots/);
    expect(block).not.toMatch(/ot\.available_slots/);
  });

  it('нет слотов впереди — честный ноль, а не прошлогодняя дата', () => {
    expect(block).toMatch(/COALESCE\(live\.free_slots, 0\) AS available_slots/);
    expect(block).toMatch(/nf\.next_date AS next_available_date/);
    // Места считаются на ТУ ЖЕ дату, что названа ближайшей.
    expect(block).toMatch(/ta\.date = nf\.next_date::date/);
  });
});
