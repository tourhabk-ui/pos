/**
 * Сторож миграции 808: старые демо-туры (вулканы, медведи, гейзеры, термальные,
 * морская рыбалка) скрыты из витрины. Они приписаны к реальному партнёру, так
 * что партнёрский фильтр (807) их не ловит — прячем по названию, обратимо.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'migrations/808_hide_legacy_demo_tours.sql'),
  'utf-8',
);

describe('миграция 808 — скрыть старые демо-туры', () => {
  it('прячет все 8 демо-туров по названию', () => {
    for (const needle of [
      'Авачинский вулкан',
      'Вулкан Горелый',
      'Медведи Курильского',
      'Долина гейзеров',
      'Термальные источники Паратунки',
      'Дачные горячие источники',
      'Морская рыбалка',
      'хребет Вачкажец',
    ]) {
      expect(src).toContain(needle);
    }
  });

  it('обратимо: unpublish, не delete, deleted_at не трогает', () => {
    expect(src).toMatch(/is_published\s*=\s*FALSE/);
    expect(src).toMatch(/is_active\s*=\s*FALSE/);
    expect(src).not.toMatch(/\bDELETE\b/i);
    expect(src).not.toMatch(/deleted_at\s*=/);
  });

  it('идемпотентна: только сейчас-видимые', () => {
    expect(src).toMatch(/is_published = TRUE OR ot\.is_active = TRUE/);
  });

  it('не задевает рыболовные и сплав по названию (нет «рыбалк»/«сплав» в матче речного продукта)', () => {
    // матч морской рыбалки — только «Морская рыбалка», не общий «%рыбалк%»
    expect(src).not.toMatch(/ILIKE '%рыбалк%'/i);
    expect(src).not.toMatch(/ILIKE '%сплав%'/i);
    expect(src).not.toMatch(/ILIKE '%Быстр/i);
  });
});
