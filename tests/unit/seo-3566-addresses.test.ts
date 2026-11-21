/**
 * #3566 (SEO, 21.11): адреса из выдачи Google не отдают 404.
 *   — /places/paratunka (такого места нет, есть маршрут) — 301 на место
 *     «Паратунская зона отдыха»;
 *   — UUID маршрута, равный собственному id строки (а не id VIEW), находит
 *     маршрут: дальше страница уводит 301 на адрес по имени.
 * Адрес по имени местам при записи (1491) держит
 * tests/integration/route-slug-on-write.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, sql: '' }));
vi.mock('@/lib/database', () => ({
  query: vi.fn(async (sql: string) => { db.sql = sql; return { rows: db.rows }; }),
}));

import { resolveToId } from '@/lib/routes/resolve-route-ref';

describe('UUID маршрута', () => {
  beforeEach(() => { db.rows = []; db.sql = ''; });

  it('собственный id строки маршрута отдаёт id VIEW, по которому страница читает карточку и slug', async () => {
    db.rows = [{ id: '11111111-1111-4111-8111-111111111111', kind: 'route' }];
    const r = await resolveToId('ee396435-26f2-4d73-9a0d-fd3f3c8b740c');
    expect(r).toEqual({ id: '11111111-1111-4111-8111-111111111111', kind: 'route' });
    expect(db.sql).toMatch(/OR id::text = \$1/);
  });

  it('ничего не нашлось — прежний исход: id как пришёл, род «маршрут»', async () => {
    expect(await resolveToId('ee396435-26f2-4d73-9a0d-fd3f3c8b740c')).toEqual({ id: 'ee396435-26f2-4d73-9a0d-fd3f3c8b740c', kind: 'route' });
  });
});

describe('/places/paratunka', () => {
  it('постоянный редирект на «Паратунскую зону отдыха»', async () => {
    const config = (await import('../../next.config.js')).default as { redirects: () => Promise<Array<{ source: string; destination: string; permanent?: boolean }>> };
    const rule = (await config.redirects()).find((r) => r.source === '/places/paratunka');
    expect(rule).toMatchObject({ destination: '/places/paratunskaya-zona-otdyha', permanent: true });
  });
});
