/**
 * Публичный поиск мест (/api/places) отдаёт только видимые записи.
 *
 * 03.10: скрытая миграциями запись-тур «Зимнее сап путешествие по реке
 * Паратунка» (is_visible = false) нашлась через этот поиск и была принята
 * за место. Скрытие, которое обходит публичный роут, — скрытие на бумаге.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));

import { GET } from '@/app/api/places/route';

describe('/api/places — только видимые места', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it('в WHERE есть p.is_visible = true — и с поиском, и без', async () => {
    for (const url of ['https://x/api/places?q=Паратун', 'https://x/api/places']) {
      await GET(new NextRequest(url));
      const sql = String(query.mock.calls.at(-1)?.[0]);
      expect(sql).toMatch(/p\.is_visible\s*=\s*true/);
    }
  });
});
