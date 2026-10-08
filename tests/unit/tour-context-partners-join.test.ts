/**
 * Каталог туров Кузьмича и MCP (аудит владельца 08.08: «MCP не отдаёт список
 * туров» — get_tours возвращал «Туры не найдены» при живых турах в БД).
 *
 * Корень: buildTourContext джойнил users и читал u.company_name, а
 * company_name существует ТОЛЬКО в partners (052: алиас для name у
 * партнёров). «column does not exist» глушился общим catch — и Кузьмич в
 * чате, и MCP оставались без каталога; get_tour_details работал, потому что
 * джойна не имел. Оператор туров — partners (§1 CLAUDE.md).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');

describe('buildTourContext: оператор — из partners', () => {
  it('джойн идёт в partners; фантомного users.company_name больше нет', () => {
    expect(CORE).toMatch(/LEFT JOIN partners p ON p\.id = ot\.operator_id/);
    expect(CORE).toMatch(/p\.name AS operator_name/);
    expect(CORE).not.toMatch(/LEFT JOIN users u ON u\.id = ot\.operator_id/);
    expect(CORE).not.toMatch(/u\.company_name/);
  });

  it('скрытые с витрины туры (837) не попадают и в каталог агентов', () => {
    // С 29.09 — общий шлюз витрины (publicTourSql): NULL в is_published
    // больше не считается опубликованным, как на сайте.
    expect(CORE).toMatch(/WHERE \$\{publicTourSql\('ot'\)\}/);
  });
});

describe('buildTourContext: обогащение не роняет каталог', () => {
  it('туры — отдельным запросом; places/knowledge — allSettled', () => {
    expect(CORE).toMatch(/const toursResult = await pool\.query<TourContextRow>/);
    expect(CORE).toMatch(/Promise\.allSettled\(\[\s*\n\s*pool\.query<\{ name: string; category/);
  });

  it('live-контекст с собственным catch', () => {
    expect(CORE).toMatch(/loadLiveContext\(\)\.catch\(\(\) => ''\)/);
  });

  it('ошибка каталога больше не глушится молча', () => {
    expect(CORE).toMatch(/console\.error\('\[buildTourContext\]/);
  });
});

describe('перф-аудит 08.08, пп. 4-5: тонкий каталог и раздельные TTL', () => {
  it('get_tours отдаёт только каталог — без блоба мест и знаний', () => {
    // loadTourCatalog — тот же каталог, но отличает отказ базы (null) от пустоты.
    expect(CORE).toMatch(/const ctx = await loadTourCatalog\(\)/);
  });

  it('TTL раздельные: туры протухают быстрее обогащения', () => {
    const catalog = Number(CORE.match(/CATALOG_TTL_MS = (\d+) \* 60 \* 1000/)?.[1]);
    const enrich = Number(CORE.match(/ENRICHMENT_TTL_MS = (\d+) \* 60 \* 1000/)?.[1]);
    expect(catalog).toBeGreaterThan(0);
    expect(enrich).toBeGreaterThan(catalog);
  });

  it('дата «СЕГОДНЯ» собирается на каждый вызов, а не кэшируется', () => {
    const composeIdx = CORE.indexOf('export async function buildTourContext');
    const compose = CORE.slice(composeIdx, composeIdx + 1200);
    expect(compose).toMatch(/СЕГОДНЯ: \$\{dateStr\}/);
    expect(compose).not.toMatch(/_tourCatalogCache =/);
  });
});

describe('get_tours: фильтр по типу активности применяется', () => {
  // С 25.09 фильтр — чистая функция lib/kuzmich/tour-filter (сверка MCP:
  // «вулканы» не тип и уходили в каталог рыбалки); её поведение держит
  // tour-filter.test.ts, здесь — что core её зовёт и правило не потерялось.
  const FILTER = readFileSync(join(process.cwd(), 'lib/kuzmich/tour-filter.ts'), 'utf-8');

  it('аргумент activity_type фильтрует строки каталога по слагу и метке', () => {
    expect(CORE).toMatch(/const want = \(args\.activity_type \?\? ''\)\.trim\(\)\.toLowerCase\(\)/);
    expect(CORE).toMatch(/filterTourCatalog\(ctx, want, activityLabel\)/);
    // Слаг и метка — по основе слова, обе подписи словаря (08.10: строкой
    // целиком «вулканы» не находили «Восхождение на вулкан»). Поведение —
    // tests/unit/tour-filter.test.ts на настоящем словаре.
    expect(FILTER).toMatch(/typeMatches\(l\.match\(\/тип:\(\\S\+\)\/\)/);
    expect(FILTER).toMatch(/words\(activityLabel\(s\)\)/);
    expect(FILTER).toMatch(/words\(activityLabel\(s, true\)\)/);
  });

  it('пустой результат фильтра — не тупик: агент получает полный каталог, но как замену', () => {
    expect(FILTER).toMatch(/Весь каталог — для замены с явной оговоркой:\\n\$\{ctx\}/);
  });
});
