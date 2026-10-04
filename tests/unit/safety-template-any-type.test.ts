/**
 * Шаблон 070/0645 узнаётся по строке, а не по нынешнему типу места (04.10).
 *
 * Снимок владельца: термальный источник с «Рельеф: forest, лимит 50,
 * сложность 2, дикие животные и погода» — ветка ELSE шаблона, выданная за
 * факт, потому что 1100 сверяла строку с шаблоном ТЕКУЩЕГО типа, а тип места
 * с тех пор поменяли. И слово «forest» печаталось как есть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIG = read('migrations/1158_safety_template_any_type.sql');

describe('1158: шаблон по строке', () => {
  it('ветка ELSE шаблона (лес, 50, 8, 2, звери+погода) — в списке', () => {
    expect(MIG).toContain("(50, 8, 2, 'forest', ARRAY['wildlife','weather']::text[])");
  });
  it('шаблоны вулкана и горячего источника — в списке', () => {
    expect(MIG).toContain("(30, 6, 4, 'mountain', ARRAY['avalanche','rockfall','thermal','altitude']::text[])");
    expect(MIG).toContain("(100, 8, 2, 'thermal', ARRAY['thermal','chemical']::text[])");
  });
  it('совпадение по всем пяти полям, и только у unknown — manual не трогается', () => {
    for (const f of ['capacity_per_day', 'optimal_group_size', 'difficulty_level', 'terrain_type', 'hazard_types']) {
      expect(MIG).toContain(`lsp.${f} = t.`);
    }
    expect(MIG).toMatch(/WHERE lsp\.profile_source = 'unknown'/);
    expect(MIG).not.toMatch(/profile_source\s*(=|IN)\s*\(?'manual'/);
  });
});

describe('карточка: рельеф словами, код без подписи не печатается', () => {
  const FACTS = read('components/places/PlaceFacts.tsx');
  it('forest → «Лес», и голый код не выводится', () => {
    expect(FACTS).toContain("forest:   'Лес'");
    expect(FACTS).toMatch(/if \(terrainType && TERRAIN_LABELS\[terrainType\]\)/);
    expect(FACTS).not.toMatch(/value: terrainType \}/);
  });
});
