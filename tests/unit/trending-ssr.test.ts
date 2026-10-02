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

describe('страница трендов собирается на сервере', () => {
  it('клиент получает списки пропсами и сам не ходит за ними', () => {
    const client = code('app/trending/_TrendingClient.tsx');
    expect(client).not.toMatch(/fetch\(/);
    expect(client).not.toMatch(/useEffect/);
    expect(code('app/trending/page.tsx')).toMatch(/loadTrending\('all', 12\)/);
    expect(code('app/trending/page.tsx')).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('страница и API читают один загрузчик', () => {
    expect(code('app/api/trending/route.ts')).toMatch(/loadTrending\(kind, limit\)/);
    expect(code('app/api/trending/route.ts')).not.toMatch(/FROM places/);
  });

  it('ссылки — по ЧПУ, тип места — из общего словаря', () => {
    const client = code('app/trending/_TrendingClient.tsx');
    expect(client).toMatch(/href=\{`\/places\/\$\{p\.slug \?\? p\.id\}`\}/);
    expect(client).toMatch(/href=\{`\/routes\/\$\{r\.slug \?\? r\.id\}`\}/);
    expect(client).toMatch(/locationTypeLabel\(p\.location_type\)/);
    expect(client).not.toMatch(/TYPE_LABELS\[/);
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
