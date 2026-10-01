/**
 * /collections отдаёт подборки сервером (аудит vedarai.ru 01.10).
 *
 * Прежде страница была оболочкой, а список тянул браузер: поисковик видел
 * 21–23 слова вместо подборок. Заодно: теги брались из уже отфильтрованного
 * списка — после выбора темы остальные исчезали; «1 объектов».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
const countMock = vi.fn();
vi.mock('@/lib/collections/resolve', () => ({ resolveCollectionCount: (...a: unknown[]) => countMock(...a) }));

import { loadPublicCollections } from '@/lib/collections/list';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const row = (id: string, tags: string[]) => ({
  id, slug: `s-${id}`, title: `Подборка ${id}`, description: null, cover_image: null, tags,
  view_count: 1, created_at: '2026-10-01', place_ids: null, route_ids: null, rule_kind: 'place',
  rule_location_type: 'volcano', rule_activity_type: null, rule_difficulty: null, rule_query: null,
  rule_limit: null, accent: null,
});

beforeEach(() => {
  poolQueryMock.mockReset();
  countMock.mockReset();
});

describe('страница подборок собирается на сервере', () => {
  it('клиент получает список пропсом и сам не ходит за ним', () => {
    const client = code('app/collections/_CollectionsClient.tsx');
    expect(client).not.toMatch(/fetch\(/);
    expect(client).not.toMatch(/useEffect/);
    expect(code('app/collections/page.tsx')).toMatch(/loadPublicCollections\(\{ limit: 50 \}\)/);
    expect(code('app/collections/page.tsx')).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('страница и API читают один загрузчик', () => {
    expect(code('app/api/collections/route.ts')).toMatch(/loadPublicCollections\(\{ tag, limit \}\)/);
    expect(code('app/api/collections/route.ts')).not.toMatch(/FROM collections/);
  });

  it('темы — из полного списка, фильтр — в памяти', () => {
    const client = code('app/collections/_CollectionsClient.tsx');
    expect(client).toMatch(/const allTags = Array\.from\(new Set\(all\.flatMap/);
    expect(client).toMatch(/all\.filter\(c => c\.tags\.includes\(activeTag\)\)/);
  });

  it('число объектов согласовано: 1 объект, 3 объекта, 5 объектов', () => {
    expect(code('app/collections/_CollectionsClient.tsx')).toMatch(/plural\(itemCount, 'объект', 'объекта', 'объектов'\)/);
  });
});

describe('загрузчик подборок', () => {
  it('пустую подборку не показывает, тег уходит параметром', async () => {
    poolQueryMock.mockResolvedValue({ rows: [row('1', ['вулканы']), row('2', ['вулканы'])] });
    countMock.mockImplementation(async (c: { id: string }) => (c.id === '1' ? 4 : 0));
    const list = await loadPublicCollections({ tag: 'вулканы', limit: 20 });
    expect(list.map((c) => c.id)).toEqual(['1']);
    expect(list[0]).toMatchObject({ item_count: 4, place_count: 4, route_count: 0 });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toMatch(/\$1 = ANY\(c\.tags\)/);
    expect(params).toEqual(['вулканы', 20]);
  });
});
