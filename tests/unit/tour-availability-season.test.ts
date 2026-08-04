/**
 * Сторож миграции 812: у туров появляются даты, и появляются ЧЕСТНО.
 *
 * Повод: на карточке тура не было календаря — только ручной ввод даты.
 * `TourDateField` показывает календарь, если `/api/tours/[id]/slots` вернул хоть
 * одну дату, а строк занятости не было вовсе: миграция 060 вставляла
 * `gen_random_uuid()` в `tour_availability.id`, который BIGSERIAL (040), —
 * вставка падала и откатывала весь CTE.
 *
 * Честность здесь важнее полноты: единственное основание для даты — СЕЗОН,
 * объявленный самим оператором. Турам без сезона и чужим операторам занятость
 * не сочиняем.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'migrations/812_tour_availability_from_season.sql'),
  'utf-8',
);

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = src.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

describe('миграция 812 — даты из объявленного сезона', () => {
  it('не задаёт id вручную: колонка BIGSERIAL, именно это роняло 060', () => {
    expect(sql).not.toMatch(/gen_random_uuid/);
    expect(sql).toMatch(/INSERT INTO tour_availability \(operator_tour_id, date/);
  });

  it('основание даты — сезон тура, а не выдумка', () => {
    expect(sql).toMatch(/season_start IS NOT NULL/);
    expect(sql).toMatch(/season_end\s+IS NOT NULL/);
  });

  it('вместимость берётся из самого тура', () => {
    expect(sql).toMatch(/max_participants/);
  });

  it('только туры двух реальных партнёров', () => {
    expect(sql).toContain("p.slug = 'kamchatka-rafting'");
    expect(sql).toMatch(/fishingkam|kamchatskaya-rybalka/);
  });

  it('только живые и опубликованные', () => {
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/is_published = TRUE/);
  });

  it('прошедшие даты в календарь не попадают', () => {
    expect(sql).toMatch(/CURRENT_DATE/);
  });

  it('окно строится на текущий год — иначе календарь опустеет в новом сезоне', () => {
    expect(sql).toMatch(/MAKE_DATE/);
    expect(sql).toMatch(/EXTRACT\(YEAR FROM CURRENT_DATE\)/);
  });

  it('идемпотентна: уникального ключа (тур, дата) в схеме нет', () => {
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).not.toMatch(/ON CONFLICT/);
  });

  it('booked_slots не переписывает — его пишет только платёжный вебхук', () => {
    expect(sql).not.toMatch(/UPDATE tour_availability/);
  });
});
