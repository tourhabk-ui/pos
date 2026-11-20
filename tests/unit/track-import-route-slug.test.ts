// @vitest-environment node
/**
 * Применение трека по адресу маршрута (20.11, треки природных парков): цель —
 * точное совпадение slug, а не поиск по похожему названию; цель по-прежнему
 * ровно одна. Судит вызов обработчика с подложенной базой.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a), connect: vi.fn() } }));
process.env.CRON_SECRET = 'test-secret';

import { POST } from '@/app/api/cron/track-import-queue/route';

const ID = '11111111-2222-4333-8444-555555555555';
function req(body: unknown): NextRequest {
  return new NextRequest('https://vedarai.ru/api/cron/track-import-queue', {
    method: 'POST', headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => query.mockReset());

describe('route_slug', () => {
  it('маршрут ищется точным адресом; не найден — 404 со словами', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: ID, status: 'pending', s3_url: 'https://s3/x.gpx', format: 'gpx' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await POST(req({ id: ID, route_slug: 'vilyuchinskij-vodopad' }));
    expect(res.status).toBe(404);
    const [sql, params] = query.mock.calls[1]!;
    expect(String(sql)).toMatch(/WHERE slug = \$1/);
    expect(String(sql)).not.toMatch(/ILIKE/);
    expect(params).toEqual(['vilyuchinskij-vodopad']);
  });

  it('цель ровно одна: slug вместе с route_id — отказ до базы', async () => {
    const res = await POST(req({ id: ID, route_slug: 'vilyuchinskij-vodopad', route_id: ID }));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('адрес — только строчные латиница, цифры и дефис', async () => {
    const res = await POST(req({ id: ID, route_slug: "x' OR 1=1 --" }));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
