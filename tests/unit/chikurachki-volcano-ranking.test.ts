// Issue #2888: Чикурачки в справочнике мест и «вулкан первым» в поиске стража.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('#2888 — Чикурачки и ранжирование вулкана', () => {
  it('миграция 1366 заводит вулкан с внешним источником координаты', () => {
    const sql = read('migrations/1366_chikurachki_volcano_place.sql');
    expect(sql).toContain("'Вулкан Чикурачки'");
    expect(sql).toMatch(/50\.324,\s*155\.461/);
    expect(sql).toContain("'volcano', 'kuril_north'");
    expect(sql).toContain("'external'");
    expect(sql).toContain('https://volcano.si.edu/volcano.cfm?vn=290360');
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it.each(['lib/kuzmich/guardian-context.ts', 'lib/kuzmich/place-info-tool.ts'])(
    '%s: вулкан сортируется раньше парка с тем же именем', (f) => {
      expect(read(f)).toContain("ORDER BY (p.location_type = 'volcano') DESC, char_length(p.name) ASC");
    });
});
