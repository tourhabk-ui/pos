/**
 * Сторож миграции 808: старые демо-туры (вулканы, медведи, гейзеры, термальные,
 * морская рыбалка) удалены из витрины. Они приписаны к реальному партнёру, так
 * что партнёрский фильтр (807) их не ловит — удаляем по названию, мягко
 * (deleted_at), как уже удалены зимние рыболовные туры.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'migrations/808_hide_legacy_demo_tours.sql'),
  'utf-8',
);

describe('миграция 808 — удалить старые демо-туры', () => {
  it('удаляет все 8 демо-туров по названию', () => {
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

  it('мягкое удаление: deleted_at + снятие публикации, без хардового DELETE', () => {
    expect(src).toMatch(/deleted_at\s*=\s*NOW\(\)/);
    expect(src).toMatch(/is_published\s*=\s*FALSE/);
    expect(src).toMatch(/is_active\s*=\s*FALSE/);
    expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('идемпотентна: трогает только ещё не удалённые', () => {
    expect(src).toMatch(/deleted_at IS NULL/);
  });

  it('не задевает рыболовные и сплав (нет общего «%рыбалк%»/«%сплав%»/«Быстр»)', () => {
    expect(src).not.toMatch(/ILIKE '%рыбалк%'/i);
    expect(src).not.toMatch(/ILIKE '%сплав%'/i);
    expect(src).not.toMatch(/ILIKE '%Быстр/i);
  });
});
