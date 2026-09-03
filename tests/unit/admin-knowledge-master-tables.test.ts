// @vitest-environment node
/**
 * Перепись админ-панели 03.09, последний пункт: «База знаний AI».
 *
 * Страница смотрела через запрещённое окно: /api/admin/knowledge читал VIEW
 * agent_route_knowledge, который CLAUDE.md §4.1 закрывает для нового кода —
 * за одним словом «маршрут» там стоят две сущности разной природы (места и
 * маршруты), и таблица показывала их неразличимо. А статистика глушила
 * отказы: четыре пустых catch отдавали нули, и «маршрутов: 0» при упавшей
 * базе выглядело ровно как пустая база (§4.0).
 *
 * Сторож держит: оба роута читают places и kamchatka_routes (со слитыми
 * отсечёнными), а не VIEW; у строки есть род; в статистике нет глухих catch,
 * отказ — null с причиной; плитка живёт в «Контенте», не в AI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const LIST = strip(read('app/api/admin/knowledge/route.ts'));
const STATS = strip(read('app/api/admin/knowledge/stats/route.ts'));
const PAGE = read('app/hub/admin/knowledge/page.tsx');
const LAYOUT = strip(read('app/hub/admin/layout.tsx'));

describe('база знаний читает master-таблицы, а не VIEW', () => {
  it('ни один из роутов не упоминает agent_route_knowledge', () => {
    expect(LIST).not.toMatch(/agent_route_knowledge/);
    expect(STATS).not.toMatch(/agent_route_knowledge/);
  });

  it('оба роута объединяют places и kamchatka_routes, отсекая слитые', () => {
    for (const src of [LIST, STATS]) {
      expect(src).toMatch(/FROM places p\s+WHERE p\.merged_into_id IS NULL/);
      expect(src).toMatch(/FROM kamchatka_routes r\s+WHERE r\.merged_into_id IS NULL/);
      expect(src).toMatch(/UNION ALL/);
    }
  });

  it('у строки есть род — место или маршрут, и по нему строится ссылка', () => {
    expect(LIST).toMatch(/'place'::text AS kind/);
    expect(LIST).toMatch(/'route'::text AS kind/);
    expect(PAGE).toMatch(/row\.kind === 'place' \? `\/places\/\$\{row\.id\}` : `\/routes\/\$\{row\.id\}`/);
  });

  it('SQL параметризован — фильтры через $n, не конкатенацией значений', () => {
    expect(LIST).toMatch(/category = \$\$\{paramIdx\+\+\}/);
    expect(LIST).toMatch(/kind = \$\$\{paramIdx\+\+\}/);
    expect(LIST).not.toMatch(/\$\{category\}|\$\{search\}|\$\{kind\}/);
  });
});

describe('статистика троична (§4.0)', () => {
  it('глухих catch больше нет — каждый отказ пишется в лог', () => {
    expect(STATS).not.toMatch(/catch \{\s*\}/);
    expect(STATS).toMatch(/console\.error\(`\[admin\/knowledge\/stats\] \$\{name\} не посчитан`/);
  });

  it('отказ — null с причиной в ответе, а не ноль', () => {
    expect(STATS).toMatch(/totals: isFailed\(totals\) \? null : totals/);
    expect(STATS).toMatch(/failures/);
    expect(PAGE).toMatch(/не посчитано/);
    expect(PAGE).toMatch(/отказ запроса, а не пустота/);
  });

  it('страница различает «не прочитано» и «пусто»', () => {
    expect(PAGE).toMatch(/Перечень не прочитан/);
    expect(PAGE).toMatch(/По этим условиям записей нет/);
  });
});

describe('плитка — в «Контенте»', () => {
  it('в меню /hub/admin/knowledge стоит в разделе Контент, не AI', () => {
    const line = LAYOUT.split('\n').find(l => l.includes("'/hub/admin/knowledge'"));
    expect(line, 'плитка базы знаний пропала из меню').toBeDefined();
    expect(line).toMatch(/section: 'Контент'/);
  });
});
