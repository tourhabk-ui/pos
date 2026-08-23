/**
 * Миграция 909 — вторая партия ремонта схемы.
 *
 * Из семи таблиц, объявленных миграциями и отсутствующих на проде, шесть
 * читает или пишет живой код. Это не мёртвые объявления, а эндпоинты,
 * которые могут только падать.
 *
 * Причина найдена, а не угадана: `02_support_tables.sql` и
 * `064_sales_tracking.sql` написаны на синтаксисе MySQL — внутри CREATE TABLE
 * у них стоит `INDEX имя (колонка)`. PostgreSQL такого не принимает, оба
 * файла не могли выполниться никогда. Сторож держит это знание: если кто-то
 * решит «просто повторить» исходные файлы, он повторит и синтаксис.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'migrations/909_restore_lost_tables.sql'), 'utf-8');
/** Запреты судятся по коду: комментарии и строковые литералы — не операторы. */
const BODY = SQL.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");

describe('миграция 909', () => {
  it('возвращает таблицы, которые читает живой код', () => {
    for (const t of ['knowledge_base_articles', 'booking_logs', 'sales_campaigns', 'sales_outreach_log']) {
      expect(BODY, `таблица ${t} не восстановлена`).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`, 'i'),
      );
    }
  });

  it('не повторяет синтаксис MySQL, на котором умерли 02 и 064', () => {
    // `INDEX имя (колонка)` внутри CREATE TABLE — то, из-за чего оба файла
    // откатывались на каждом деплое, записываясь применёнными.
    expect(BODY).not.toMatch(/^\s*INDEX\s+\w+\s*\(/mi);
    // Индексы объявлены отдельными операторами, как требует Postgres.
    expect((BODY.match(/CREATE INDEX IF NOT EXISTS/gi) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it('ключ журнала броней ведёт на operator_bookings, а не на bookings', () => {
    // 019 объявлял `booking_id UUID REFERENCES bookings(id)`. Броня живёт в
    // operator_bookings, её id — bigint; к тому же род отношения `bookings`
    // на боевой базе не установлен, а ключа на представление не бывает.
    const logs = BODY.slice(BODY.indexOf('CREATE TABLE IF NOT EXISTS booking_logs'));
    expect(logs).toMatch(/booking_id\s+BIGINT\s+NOT NULL REFERENCES operator_bookings\(id\)/i);
    expect(logs.slice(0, logs.indexOf(');'))).not.toMatch(/REFERENCES\s+bookings\b/i);
  });

  it('не трогает то, чего не может починить одна лишь схема', () => {
    // reference_tours и composite_bookings пропали вместе с 081, но их код
    // сломан отдельно: один ходит в несуществующую таблицу `operators`,
    // другой вставляет tourist_id = 0. Вернуть таблицу и отчитаться о
    // починке значило бы соврать — эндпоинты падали бы дальше.
    expect(BODY).not.toMatch(/CREATE TABLE IF NOT EXISTS reference_tours\b/i);
    expect(BODY).not.toMatch(/CREATE TABLE IF NOT EXISTS composite_bookings\b/i);
  });

  it('не заводит таблицу, к которой нет ни одного обращения', () => {
    // agent_core_memory: 0 читателей, 0 писателей. Заводить её — плодить
    // схему; вносить в список «отсутствуют сознательно» — решение владельца,
    // а не миграции. Остаётся видимой в переписи как нерешённое.
    expect(BODY).not.toMatch(/agent_core_memory/i);
  });

  it('идемпотентна', () => {
    const creates = BODY.match(/CREATE TABLE/gi) ?? [];
    const guarded = BODY.match(/CREATE TABLE IF NOT EXISTS/gi) ?? [];
    expect(guarded.length).toBe(creates.length);
    const adds = BODY.match(/ADD COLUMN/gi) ?? [];
    const addsGuarded = BODY.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(addsGuarded.length).toBe(adds.length);
  });

  it('шапка называет замер и дату, а не «похоже, потерялось»', () => {
    expect(SQL).toMatch(/schema-drift/);
    expect(SQL).toMatch(/23\.08\.2026/);
  });
});

describe('исходные файлы остаются свидетельством', () => {
  it('02 и 064 по-прежнему содержат синтаксис MySQL — их не «подчищали»', () => {
    // Соблазн переписать старые файлы велик, но они уже числятся
    // применёнными: правка ничего не накатит, зато сотрёт улику, по которой
    // причина и была найдена. Пусть лежат как есть.
    const s02 = readFileSync(join(process.cwd(), 'migrations/02_support_tables.sql'), 'utf-8');
    const s064 = readFileSync(join(process.cwd(), 'migrations/064_sales_tracking.sql'), 'utf-8');
    expect(s02).toMatch(/^\s*INDEX\s+\w+\s*\(/mi);
    expect(s064).toMatch(/^\s*INDEX\s+\w+\s*\(/mi);
  });
});
