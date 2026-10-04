/**
 * Миграция 1172: место, которое маршрут называет ВСЕМИ словами имени, —
 * точка пути (04.10, Замок/Козельский/Три Брата/Халактырский пляж).
 *
 * Сторож держит обе стороны: четыре случая владельца в списке, и ни одной
 * ложной пары, которую дала бы мягкая улика «значимых слов» (родовое слово
 * имени отброшено, совпало одно собственное).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'migrations/1172_named_place_is_waypoint.sql'), 'utf8');
const rows = SQL.split('\n').filter(l => l.startsWith("    ('"));

describe('1172: точки пути по имени', () => {
  it('список явный, каждая пара по двум id', () => {
    expect(rows.length).toBe(91);
    for (const r of rows) expect(r).toMatch(/^ {4}\('[0-9a-f-]{36}', '[0-9a-f-]{36}'\),?\s+-- .+ ← .+$/);
  });

  it('случаи владельца — в списке', () => {
    for (const pair of ['Скалы Три Брата ← Скалы Три Брата', 'Халактырский пляж ← Халактырский пляж', 'Озеро Приливное – Халактырский пляж ← Халактырский пляж']) {
      expect(rows.some(r => r.includes(pair)), pair).toBe(true);
    }
  });

  it('ложных пар мягкой улики нет', () => {
    for (const bad of ['← Вилючинский перевал', '← Корякские нарзаны', '← Мыс Налычева', 'Однодневный поход к Авачинскому вулкану ←']) {
      expect(rows.some(r => r.includes(bad)), bad).toBe(false);
    }
  });

  it('трогает только «рядом», не unknown и не waypoint', () => {
    expect(SQL).toContain("AND rw.link_kind = 'nearby';");
    expect(SQL).toContain("SET link_kind = 'waypoint'");
  });
});
