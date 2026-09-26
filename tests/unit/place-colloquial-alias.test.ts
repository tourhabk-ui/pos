/**
 * Сторож: разговорное имя вулкана находит его статус (issue #2063, #2065).
 *
 * Дайджест 26.09, подтверждено пробой с прода: «Ключевской», «Ключевской
 * вулкан», «Вулкан Ключевской» не находили «Вулкан Ключевская сопка» — страж
 * отдавал одну этнографическую заметку без цвета, KVERT и опасностей, в дни
 * извержения соседнего Шивелуча. Тот же дефект — у «Корякский вулкан» и
 * «Авачинская сопка».
 *
 * Поведение SQL проверено на PostgreSQL 16 (26.09, транзакция с откатом):
 * восемь запросов, включая ловушки «Авачинская бухта», «Авачинский перевал»,
 * «Корякский природный заповедник», «Вид на долину у Ключевских вулканов», —
 * каждый нашёл своё место с высоким совпадением; повтор миграции — no-op.
 * Здесь держится форма, которая это даёт.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeNameOrAliasSearchSql } from '@/lib/places/name-match';
import { gradeNameMatch, gradePlaceMatch, getGuardianContext } from '@/lib/kuzmich/guardian-context';
import { composePlaceInfo } from '@/lib/kuzmich/place-info-tool';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('поиск места — по названию ИЛИ псевдониму', () => {
  it('одни слова и плейсхолдеры на обе ветки', () => {
    const m = placeNameOrAliasSearchSql('p', 'Ключевской вулкан', 1);
    expect(m.params).toEqual(['%ключевской%', '%вулкан%']);
    expect(m.clause).toContain('p.name ILIKE $1 AND p.name ILIKE $2');
    expect(m.clause).toContain('EXISTS (SELECT 1 FROM place_aliases pa WHERE pa.place_id = p.id::text AND (pa.alias ILIKE $1 AND pa.alias ILIKE $2))');
  });

  it('страж, ссылка стража и get_place_info ищут через псевдонимы', () => {
    const g = read('lib/kuzmich/guardian-context.ts');
    expect(g.match(/placeNameOrAliasSearchSql\('p', /g)?.length).toBe(2);
    expect(g).not.toMatch(/placeNameSearchSql\(/);
    const info = read('lib/kuzmich/place-info-tool.ts');
    expect(info).toContain("placeNameOrAliasSearchSql('p', placeName, 1)");
  });
});

describe('совпадение — сильное и по псевдониму', () => {
  it('морфология против названия по-прежнему слабая (решение прежних тестов)', () => {
    expect(gradeNameMatch('Ключевской', 'Вулкан Ключевская сопка')).toBe('low');
  });

  it('против записанного псевдонима — сильное', () => {
    expect(gradePlaceMatch('Ключевской', 'Вулкан Ключевская сопка', ['Ключевской вулкан'])).toBe('high');
    expect(gradePlaceMatch('Вулкан Ключевской', 'Вулкан Ключевская сопка', ['Ключевской вулкан'])).toBe('high');
    expect(gradePlaceMatch('Авачинская сопка', 'Вулкан Авачинский', ['Авачинская сопка'])).toBe('high');
  });

  it('без псевдонима ничего не меняется', () => {
    expect(gradePlaceMatch('Толбачик', 'Толбачинский дол дальний кордон', null)).toBe('low');
  });

  it('страж судит место через gradePlaceMatch и выбирает псевдонимы строки', () => {
    const g = read('lib/kuzmich/guardian-context.ts');
    expect(g).toContain('gradePlaceMatch(placeName, p.name, p.aliases)');
    expect(g).toMatch(/SELECT array_agg\(pa\.alias ORDER BY pa\.alias\)\s+FROM place_aliases pa\s+WHERE pa\.place_id = p\.id::text\) AS aliases/);
  });
});

describe('места нет — так и сказано', () => {
  beforeEach(() => vi.clearAllMocks());

  it('страж: одна заметка без места начинается с «не нашлось»', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_knowledge')) {
        return Promise.resolve({ rows: [{ title: 'Ключевской вулкан — самый почитаемый', compiled_truth: 'Огненная гора богов', type: 'indigenous' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const ctx = await getGuardianContext('Вулкан Ключевской');
    expect(ctx.split('\n')[0]).toContain('Места «Вулкан Ключевской» в справочнике не нашлось');
    expect(ctx).toContain('KVERT');
    expect(ctx).toContain('[Традиционные знания]');
  });

  it('страж: место нашлось — строки «не нашлось» нет', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) {
        return Promise.resolve({ rows: [{ name: 'Вулкан Ключевская сопка', aliases: ['Ключевской вулкан'], location_type: 'volcano', recommender_status: 'red', hazard_types: ['avalanche'] }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const ctx = await getGuardianContext('Ключевской');
    expect(ctx).not.toContain('не нашлось');
    expect(ctx).not.toContain('неточное совпадение');
    expect(ctx).toContain('Вулкан Ключевская сопка');
  });

  it('get_place_info: заметка без места помечена', () => {
    const out = composePlaceInfo('Ключевской', [], [{ title: 'Ключевской вулкан — самый почитаемый', compiled_truth: 'Огненная гора богов' }]);
    expect(out?.split('\n')[0]).toContain('Места «Ключевской» в справочнике не нашлось');
  });
});

describe('миграция 1032 — псевдонимы поимённо', () => {
  const MIG = read('migrations/1032_volcano_colloquial_aliases.sql');

  it('кладёт имя, только если совпали id и название живого места', () => {
    expect(MIG).toMatch(/JOIN places p ON p\.id::text = w\.place_id::text AND p\.name = w\.place_name/);
    expect(MIG).toMatch(/WHERE p\.merged_into_id IS NULL/);
    expect(MIG).toMatch(/ON CONFLICT \(place_id, LOWER\(TRIM\(alias\)\)\) DO NOTHING/);
  });

  it('три вулкана и их разговорные имена', () => {
    expect(MIG).toContain("'Вулкан Ключевская сопка', 'Ключевской вулкан'");
    expect(MIG).toContain("'Корякская сопка', 'Корякский вулкан'");
    expect(MIG).toContain("'Вулкан Авачинский', 'Авачинская сопка'");
  });
});
