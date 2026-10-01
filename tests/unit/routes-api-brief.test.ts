/**
 * /api/routes?brief=1 отдаёт первую строку описания, без параметра — как раньше
 * (аудит 01.10: карта тянула 1500 полных описаний, 653 КБ, а показывает из
 * каждого первую строку в попапе).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

const long = 'Вулкан на востоке полуострова, подъём по осыпи. ' + 'Склон крутой. '.repeat(60) + '\nВторой абзац про снаряжение.';
vi.mock('@/lib/routes/catalog-query', async (orig) => {
  const real = await orig<typeof import('@/lib/routes/catalog-query')>();
  return {
    ...real,
    queryCatalog: vi.fn(async () => ({ items: [{ id: 'a', title: 'Вулкан', description: long }], meta: { total: 1, page: 1, limit: 1, pages: 1 } })),
  };
});

import { GET } from '@/app/api/routes/route';

async function body(url: string) {
  const res = await GET(new NextRequest(url));
  return (await res.json()) as { data: Array<{ description: string }> };
}

describe('/api/routes brief', () => {
  it('brief=1 — первая строка, до 200 знаков', async () => {
    const { data } = await body('http://x/api/routes?kind=place&brief=1');
    expect(data[0].description.length).toBeLessThanOrEqual(201);
    expect(data[0].description).not.toMatch(/Второй абзац/);
    expect(data[0].description.startsWith('Вулкан на востоке')).toBe(true);
  });

  it('без параметра ответ прежний', async () => {
    const { data } = await body('http://x/api/routes?kind=place');
    expect(data[0].description).toBe(long);
  });

  it('карта просит brief', () => {
    expect(readFileSync('app/map/_MapPageClient.tsx', 'utf-8')).toMatch(/kind=place&brief=1'/);
  });
});
