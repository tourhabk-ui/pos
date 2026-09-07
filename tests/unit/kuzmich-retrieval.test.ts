/**
 * Сторож поиска мест Кузьмича.
 *
 * Поиск не работал НИКОГДА, и держалось это на трёх дефектах, каждый из
 * которых прятал два остальных:
 *
 *   1. `search_text` в представлении объявлен `NULL::tsvector` — колонка с
 *      именем «текст для поиска» текста для поиска не содержала;
 *   2. запрос оборачивал её в `to_tsvector('russian', search_text)`, а
 *      функции `to_tsvector(regconfig, tsvector)` не существует — 42883 на
 *      КАЖДОМ вызове, не иногда;
 *   3. отказ глотал пустой `catch { return ''; }`.
 *
 * Итог: Кузьмич отвечал на вопросы о безопасности по памяти модели. Сторож
 * держит все три двери, потому что закрытых по одной не хватало.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const CORE = readFileSync('lib/kuzmich/core.ts', 'utf8');
const PROBE = readFileSync('app/api/cron/retrieval-probe/route.ts', 'utf8');
const MIGRATION_RAW = readFileSync(
  'migrations/942_agent_route_knowledge_search_text.sql', 'utf8');
/**
 * Комментарии срезаны: в шапке миграции разобран сам дефект, и слова
 * `to_tsvector(regconfig, tsvector)` оттуда попадали в сравнение выражений.
 * Первая версия этого теста на них и споткнулась.
 */
const MIGRATION = MIGRATION_RAW.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('дефект 1: колонка обязана содержать то, что обещает имя', () => {
  it('в миграции 942 search_text — настоящий tsvector в ОБЕИХ ветках UNION', () => {
    const built = MIGRATION.match(/AS\s+search_text/g) ?? [];
    expect(built).toHaveLength(2);
    expect(MIGRATION).not.toMatch(/NULL::tsvector\s+AS\s+search_text/);
  });

  it('состав полей взят из миграции 104, а не придуман заново', () => {
    // Места: name + description + location_type + activity_type.
    expect(MIGRATION).toMatch(/COALESCE\(p\.name/);
    expect(MIGRATION).toMatch(/COALESCE\(p\.location_type/);
    // Маршруты: title + description + activity_type (location_type у них нет).
    expect(MIGRATION).toMatch(/COALESCE\(r\.title/);
  });

  it('последняя миграция, трогавшая представление, не вернула NULL обратно', () => {
    const viewMigrations = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => readFileSync(`migrations/${f}`, 'utf8')
        .includes('CREATE OR REPLACE VIEW agent_route_knowledge'))
      .sort();
    const last = viewMigrations[viewMigrations.length - 1];
    const body = readFileSync(`migrations/${last}`, 'utf8');
    expect(body, `представление последний раз заменяет ${last}`)
      .not.toMatch(/NULL::tsvector\s+AS\s+search_text/);
  });
});

describe('индекс обязан совпасть с представлением, иначе он мёртв', () => {
  // Выражение в индексе и выражение в представлении сравниваются планировщиком
  // ПОСИМВОЛЬНО. Разошлись — индекс не берётся, и на каждый запрос tsvector
  // строится заново по всем строкам. Такое расхождение не видно ничем, кроме
  // EXPLAIN, поэтому держим его тестом.
  const norm = (t: string) => t
    .replace(/\s+/g, ' ')
    .replace(/\b[pr]\./g, '')
    .toLowerCase()
    .trim();

  // Выражения представления ищем ТОЛЬКО в теле представления: иначе поиск
  // стартует с первого to_tsvector в файле (а это индекс) и тянет всё подряд.
  const VIEW_BODY = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE VIEW'));
  const viewExprs = [...VIEW_BODY.matchAll(
    /(to_tsvector\('russian',[\s\S]*?\))\s+AS\s+search_text/g)].map((m) => norm(m[1]));
  const indexExprs = [...MIGRATION.matchAll(
    /USING GIN \((to_tsvector\('russian',[\s\S]*?\))\);/g)].map((m) => norm(m[1]));

  it('индексов столько же, сколько веток представления', () => {
    expect(viewExprs).toHaveLength(2);
    expect(indexExprs).toHaveLength(2);
  });

  it('каждое выражение представления имеет ровно такой же индекс', () => {
    for (const expr of viewExprs) expect(indexExprs).toContain(expr);
  });
});

describe('дефект 2: tsvector нельзя оборачивать в to_tsvector', () => {
  it('в живом пути Кузьмича обёртки нет', () => {
    expect(CORE).not.toMatch(/to_tsvector\(\s*'russian'\s*,\s*search_text\s*\)/);
    expect(CORE).toMatch(/search_text @@ plainto_tsquery/);
  });

  it('в пробе достижимости тоже нет — она падала той же ошибкой', () => {
    expect(PROBE).not.toMatch(/to_tsvector\(\s*'russian'\s*,\s*search_text\s*\)/);
    expect(PROBE).toMatch(/search_text @@ to_tsquery/);
  });
});

describe('дефект 3: отказ не глушится и виден модели', () => {
  it('пустых catch в мозге Кузьмича не осталось ни одного', () => {
    // Их было пять: поиск мест, погода, внешние тревоги и две сводки. Отказ,
    // проглоченный молча, живёт незамеченным ровно столько, сколько прожил
    // поиск мест — полтора месяца.
    expect(CORE).not.toContain("} catch { return ''; }");
  });

  it('каждый отказ живого контекста называет свой источник', () => {
    for (const source of ['прогноз погоды', 'внешние тревоги', 'сводка из базы', 'сводка по группам']) {
      expect(CORE).toContain(`logSwallowed('${source}'`);
    }
  });

  it('тишина про тревоги не выдаётся за «предупреждений нет»', () => {
    expect(CORE).toContain('ТРЕВОГИ НЕДОСТУПНЫ');
    expect(CORE).toMatch(/Не утверждай, что их нет/);
  });

  it('отказ пишется в лог с кодом SQLSTATE', () => {
    expect(CORE).toContain('[kuzmich] поиск мест не выполнен');
    expect(CORE).toMatch(/code,/);
  });

  it('модели говорят «не смог», а не «ничего не нашлось»', () => {
    // «Не нашлось» и «не смог посмотреть» — разные вещи, и во втором случае
    // выдумывать координаты нельзя (§4.0).
    expect(CORE).toContain('СПРАВОЧНИК МЕСТ НЕДОСТУПЕН');
    expect(CORE).toMatch(/не смог проверить/);
  });

  it('пустой результат и отказ — разные ответы', () => {
    // Ноль находок — пустая строка; отказ — предупреждение. Если их
    // сравнять, «не нашлось» и «не смог посмотреть» снова станут одним.
    expect(CORE).toContain("if (!results.length) return '';");
    // lastIndexOf, а не indexOf: те же слова стоят в системном промпте выше.
    const searchCatch = CORE.slice(CORE.lastIndexOf('МЕСТА ПО ЗАПРОСУ'));
    expect(searchCatch.slice(0, 900)).toContain('СПРАВОЧНИК МЕСТ НЕДОСТУПЕН');
  });
});
