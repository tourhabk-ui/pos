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

  // С 09.11 порядок один на обоих — lib/places/name-match (placeRankOrderSql):
  // точное имя и псевдоним первыми (аудит: «Курильское озеро» отдавало
  // кальдеру), а среди неточных совпадений вулкан по-прежнему раньше парка с
  // тем же именем. Исполнение на базе — tests/integration/mcp-search.pg.test.ts.
  it('порядок мест: точное имя, точный псевдоним, потом вулкан, потом кратчайшее имя', async () => {
    const { placeRankOrderSql } = await import('@/lib/places/name-match');
    const sql = placeRankOrderSql('p', 4);
    const at = (needle: string) => sql.indexOf(needle);
    // Ключи порядка идут ровно в этом порядке; исполнение — mcp-search.pg.test.ts.
    expect(at('btrim(p.name)')).toBeGreaterThanOrEqual(0);
    expect(at('FROM place_aliases')).toBeGreaterThan(at('btrim(p.name)'));
    expect(at("(p.location_type = 'volcano') DESC")).toBeGreaterThan(at('FROM place_aliases'));
    expect(sql.endsWith('char_length(p.name) ASC')).toBe(true);
    expect(sql.match(/= \$4\) DESC/g)).toHaveLength(2);
  });

  it('get_place_info и страж зовут одно правило; у стража видимые по-прежнему первыми (08.11)', () => {
    expect(read('lib/kuzmich/place-info-tool.ts')).toContain("ORDER BY ${placeRankOrderSql('p', exactParam)}");
    expect(read('lib/kuzmich/guardian-context.ts')).toContain(
      "ORDER BY (p.is_visible IS NOT FALSE) DESC, ${placeRankOrderSql('p', exactParam)}",
    );
  });
});
