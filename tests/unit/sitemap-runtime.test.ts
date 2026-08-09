/**
 * Sitemap исполняется на запросе, а не на сборке (живая проверка владельца
 * 08.08: в sitemap.xml прода 0 URL вида catalog/tours при живом llms.txt).
 *
 * Корень: метадата-роут app/sitemap.ts Next пререндерит НА СБОРКЕ, а на
 * Timeweb-сборке БД недоступна по построению — все динамические секции
 * молча пустели. llms.txt жил, потому что он route-handler. Теперь sitemap —
 * тоже route-handler (app/sitemap.xml/route.ts) с force-dynamic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/sitemap.xml/route.ts'), 'utf-8');
const ENTRIES = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');

describe('sitemap — runtime, не build-time', () => {
  it('метадата-роута больше нет — только route-handler', () => {
    expect(existsSync(join(ROOT, 'app/sitemap.ts'))).toBe(false);
    expect(ROUTE).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(ROUTE).toMatch(/collectSitemapEntries/);
  });

  it('XML честный: экранирование и заголовки на месте', () => {
    expect(ROUTE).toMatch(/xmlEscape/);
    expect(ROUTE).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(ROUTE).toMatch(/application\/xml/);
    expect(ROUTE).toMatch(/s-maxage=3600/);
  });

  it('сборщик записей сохранил туры с витринными флагами (#1049)', () => {
    expect(ENTRIES).toMatch(/catalog\/tours\/\$\{row\.id\}/);
    expect(ENTRIES).toMatch(/is_active = TRUE/);
    expect(ENTRIES).toMatch(/COALESCE\(is_published, TRUE\) = TRUE/);
  });

  it('IndexNow bulk переехал на общий сборщик', () => {
    const bulk = readFileSync(join(ROOT, 'app/api/admin/indexnow/bulk/route.ts'), 'utf-8');
    expect(bulk).toMatch(/collectSitemapEntries/);
    expect(bulk).not.toMatch(/@\/app\/sitemap/);
  });
});
