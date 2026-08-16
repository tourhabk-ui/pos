/**
 * В ORDER BY каталога нет голых имён колонок.
 *
 * 16.08, SQLSTATE 42702: `column reference "description" is ambiguous` —
 * каталог отдавал 503, планировщик открывался пустым. Причина в правиле
 * разрешения имён Postgres, которое легко не заметить:
 *
 *   - голое имя в ORDER BY ищется сначала среди ВЫХОДНЫХ колонок SELECT
 *     (поэтому соседнее `title ASC` не падало);
 *   - имя ВНУТРИ выражения (`length(COALESCE(description, ''))`) резолвится
 *     по таблицам FROM — а там `description` есть и у `ark`, и у
 *     присоединённой `kamchatka_routes krl`.
 *
 * Ломается это не при правке сортировки, а при добавлении JOIN: запрос,
 * годами работавший, падает от строки, написанной в другом месте и по
 * другому поводу. Так уже было с `is_visible` (проба 84) — и повторилось.
 *
 * Отсюда правило: в ORDER BY каталога каждое имя колонки квалифицировано
 * алиасом, включая те, что сейчас однозначны. Исключение одно — вычисленные
 * колонки SELECT (`has_real_image`): своей таблицы у них нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/routes/catalog-query.ts'), 'utf-8');

/** Тело выражения orderBy — от объявления до закрывающей строки. */
function orderByBlock(): string {
  const start = SRC.indexOf('const orderBy =');
  expect(start, 'не найдено выражение orderBy').toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  const end = rest.indexOf("'ark.title ASC';");
  expect(end, 'не найден конец выражения orderBy').toBeGreaterThan(-1);
  return rest.slice(0, end + "'ark.title ASC';".length)
    // Комментарии описывают прежнюю ошибку намеренно.
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('сортировка каталога не зависит от того, кого приджойнили', () => {
  it('description квалифицирован — та самая колонка из 42702', () => {
    expect(orderByBlock()).toMatch(/length\(COALESCE\(ark\.description, ''\)\)/);
  });

  it('голого description в сортировке не осталось', () => {
    expect(orderByBlock()).not.toMatch(/COALESCE\(description/);
  });

  it('title и created_at тоже квалифицированы, хотя сейчас не падают', () => {
    // Однозначность сегодня — не гарантия на завтра: она держится тем, что
    // никто не приджойнил таблицу с такой же колонкой.
    const block = orderByBlock();
    expect(block).not.toMatch(/(?<!\.)\btitle ASC/);
    expect(block).not.toMatch(/(?<!\.)\bcreated_at DESC/);
  });

  it('payload и location_type квалифицированы', () => {
    const block = orderByBlock();
    expect(block).not.toMatch(/(?<!\.)\bpayload->>/);
    expect(block).not.toMatch(/CASE location_type/);
    expect(block).toMatch(/CASE ark\.location_type/);
  });

  it('вычисленная колонка SELECT остаётся без префикса', () => {
    // has_real_image считается в SELECT, таблицы у неё нет — префикс сломал бы.
    expect(orderByBlock()).toMatch(/\n\s*has_real_image DESC/);
  });
});

describe('условия WHERE тоже квалифицированы (проба 84 не должна вернуться)', () => {
  it('is_visible и координаты идут через алиас', () => {
    expect(SRC).toMatch(/ark\.is_visible = TRUE/);
    expect(SRC).toMatch(/ark\.lat IS NOT NULL AND ark\.lng IS NOT NULL/);
  });
});
