// @vitest-environment node
/**
 * Шапки витрин жилья и трансферов — по образцу каталога туров (владелец
 * 12.10, снимки с телефона: «жильё: верхний блок забирает много места»,
 * «трансферы тоже нужно, наверное, по образцу туров»).
 *
 * Образец — герой /catalog: заголовок 28px на телефоне, описание только с
 * sm, дальше сразу дело. Сторож держит три шапки в одном размере и не даёт
 * вернуть на телефон длинное описание; счётчик жилья склоняется
 * («1 объект», не «1 объектов» — тот же класс бага, что на /safety).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const CATALOG = read('components/marketplace/MarketplaceClient.tsx');
const STAYS = read('app/accommodations/_AccommodationsClient.tsx');
const TRANSFERS = read('components/transfers/TransfersPage.tsx');

const h1Class = (src: string) => /<h1\s+className="([^"]+)"/.exec(src)?.[1] ?? '';

describe('шапки витрин по образцу каталога туров', () => {
  it('заголовок на телефоне 28px — как у героя каталога', () => {
    expect(h1Class(CATALOG)).toContain('text-[28px]');
    expect(h1Class(STAYS)).toContain('text-[28px]');
    expect(h1Class(TRANSFERS)).toContain('text-[28px]');
    // Без префикса sm: — крупный заголовок ушёл бы и на телефон.
    expect(h1Class(STAYS)).not.toMatch(/(^|\s)text-4xl\b/);
    expect(h1Class(TRANSFERS)).not.toMatch(/\bds-h1\b/);
  });

  it('жильё: описание только с sm, даты в одной строке, счётчик склоняется', () => {
    expect(STAYS).toMatch(/<p className="hidden sm:block[^"]*">\s*Отели, хостелы/);
    expect(STAYS).toContain('grid grid-cols-2 gap-3 w-full sm:contents');
    expect(STAYS).toContain("plural(total, 'объект', 'объекта', 'объектов')");
    expect(STAYS).not.toMatch(/`\$\{total\} объектов`/);
    expect(STAYS).toMatch(/className="max-w-7xl mx-auto px-4 py-5 sm:py-10"/);
  });

  // Трансферы: «на телефоне одна строка сути, подробности с sm» судит рендер —
  // tests/unit/transfers-page.test.tsx (страница переделана 13.10: сначала
  // машина под заказ, места в поездках — списком, без формы дат).
});
