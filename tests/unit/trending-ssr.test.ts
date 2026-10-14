/**
 * /trending отдаёт списки сервером (аудит vedarai.ru 01.10).
 *
 * Прежде страница была оболочкой, а список тянул браузер: поисковик видел
 * 21–23 слова. Тогда же: места шли без is_visible и без слитых, снимок брался
 * из произвольной строки (нарисованная прятала настоящую), ссылки — по UUID с
 * редиректом на ЧПУ, тип места — из своего словаря на девять слов («WATERFALL»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));

import { loadTrending } from '@/lib/trending/load';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

beforeEach(() => {
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [] });
});

// Что видит человек — ссылки, подписи, оба списка — держит рендер страницы
// (tests/unit/trending-page.test.tsx, 14.10). Здесь — запреты и общий загрузчик.
describe('страница трендов собирается на сервере', () => {
  it('списки не тянет браузер и вкладок, прячущих один из них, нет', () => {
    const lists = code('components/trending/TrendingLists.tsx');
    expect(lists).not.toMatch(/fetch\(/);
    expect(lists).not.toMatch(/useEffect/);
    expect(lists).not.toMatch(/useState/);
    expect(lists).not.toMatch(/^'use client'/m);
  });

  it('страница и API читают один загрузчик', () => {
    expect(code('app/api/trending/route.ts')).toMatch(/loadTrending\(kind, limit\)/);
    expect(code('app/api/trending/route.ts')).not.toMatch(/FROM places/);
  });

  it('тип места — из общего словаря, своего нет', () => {
    expect(code('components/trending/TrendingLists.tsx')).not.toMatch(/TYPE_LABELS\[/);
  });
});

describe('загрузчик: только видимые, настоящий снимок, без двойников', () => {
  const sqlOf = (needle: string) =>
    String(poolQueryMock.mock.calls.map(([sql]) => sql).find((sql: string) => sql.includes(needle)));

  it('места — видимые и не слитые, снимок — только показываемого рода', async () => {
    await loadTrending('places', 12);
    const sql = sqlOf('FROM places p');
    expect(sql).toMatch(/p\.is_visible = TRUE/);
    expect(sql).toMatch(/p\.merged_into_id IS NULL/);
    expect(sql).toMatch(/CASE WHEN EXISTS \(SELECT 1 FROM ai_route_images ai/);
    expect(sql).toMatch(/ai\.model IN \(/);
    expect(sql).toMatch(/p\.slug/);
  });

  it('маршруты — без двойников мест, со slug', async () => {
    await loadTrending('routes', 12);
    const sql = sqlOf('FROM kamchatka_routes');
    expect(sql).toMatch(/COALESCE\(ark_id, id\) AS id, slug/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM places tp/);
  });

  it('вид списка решает, какие запросы идут', async () => {
    expect(await loadTrending('places', 5)).toEqual({ places: [] });
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });
});
