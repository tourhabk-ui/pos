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
    expect(CORE).toMatch(/COALESCE\(ot\.is_published, TRUE\) = TRUE/);
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

describe('get_tours: фильтр по типу активности применяется', () => {
  it('аргумент activity_type фильтрует строки каталога по слагу и метке', () => {
    expect(CORE).toMatch(/const want = \(args\.activity_type \?\? ''\)\.trim\(\)\.toLowerCase\(\)/);
    expect(CORE).toMatch(/type\.includes\(want\) \|\| label\.includes\(want\)/);
  });

  it('пустой результат фильтра — не тупик: агент получает полный каталог', () => {
    expect(CORE).toMatch(/туров сейчас нет\. Полный каталог:/);
  });
});
