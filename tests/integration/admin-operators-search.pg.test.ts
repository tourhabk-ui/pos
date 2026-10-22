/**
 * Поиск партнёров в админке «Операторы» — на настоящем PostgreSQL (16.10).
 *
 * Владелец: «где Камчатская рыбалка?» — поиск по «Камч» находил только
 * «Местечко Камчатка». Экран брал первые 100 партнёров (по дате заявки, затем
 * заведения) и искал только среди них, а партнёров больше сотни: давняя
 * карточка за сотней новых не находилась вовсе, и об обрезке экран молчал.
 *
 * Теперь ищет роут (`q`), и счёт `meta.total` идёт тем же условием. Здесь —
 * исполнение роута против базы с той же схемой, что на проде: старая карточка
 * за сотней новых на первой странице не видна, но находится по названию и по
 * почте контакта; `%` ищется буквально; страницы складываются ровно в итог.
 * Без KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'admin-test', role: 'admin' })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[admin-operators-search.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'admin_operators_search_test';
const OLD_ID = 'b2160000-0000-4000-8000-000000000001';
const OLD_NAME = 'Камчатская рыбалка (тест)';
const CONTACT_EMAIL = 'anatoly-search@fishingkam.test';
const NEWER = 110;

interface Row { id: string; company_name: string }
interface Body { success: boolean; data: Row[]; meta: { total: number; limit: number; offset: number } }

async function list(params: Record<string, string>): Promise<Body> {
  const { GET } = await import('@/app/api/admin/operators/route');
  const qs = new URLSearchParams(params).toString();
  const res = await GET(new NextRequest(`https://vedarai.ru/api/admin/operators?${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

withPg('админка «Операторы»: поиск по всем партнёрам, а не по первой сотне (16.10)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    // Давняя карточка: заявки нет, заведена год назад — в конце порядка.
    const { rows: [user] } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Анатолий (тест)', 'x', 'operator') RETURNING id`,
      [CONTACT_EMAIL],
    );
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, status, user_id, created_at, applied_at)
       VALUES ($1, $2, 'operator', '{}'::jsonb, 'test-kamfishing-search', TRUE, 'active', $3,
               NOW() - INTERVAL '400 days', NULL)`,
      [OLD_ID, OLD_NAME, user.id],
    );
    // Сотня с лишним новее — как гиды, заведённые позже.
    await pool.query(
      `INSERT INTO partners (name, category, contact, slug, is_public, status, created_at, applied_at)
       SELECT 'Гид ' || g || ' (тест поиска)', 'guide', '{}'::jsonb, 'test-search-guide-' || g, TRUE, 'active',
              NOW() - make_interval(mins => g), NULL
         FROM generate_series(1, $1::int) AS g`,
      [NEWER],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('первая сотня давнюю карточку не содержит — то, что видел владелец', async () => {
    const page = await list({ status: 'all', limit: '100' });
    expect(page.data).toHaveLength(100);
    expect(page.meta.total).toBeGreaterThan(100);
    expect(page.data.map((r) => r.id)).not.toContain(OLD_ID);
  });

  it('поиск находит её по названию, где бы она ни стояла в порядке', async () => {
    const found = await list({ status: 'all', limit: '100', q: 'камчатская рыб' });
    expect(found.data.map((r) => r.id)).toContain(OLD_ID);
    expect(found.meta.total).toBe(found.data.length);
    for (const r of found.data) expect(r.company_name.toLowerCase()).toContain('камчатская рыб');
  });

  it('и по почте контакта', async () => {
    const found = await list({ status: 'all', q: CONTACT_EMAIL });
    expect(found.data.map((r) => r.id)).toEqual([OLD_ID]);
    expect(found.meta.total).toBe(1);
  });

  it('поиск идёт внутри группы: давняя карточка без заявки — среди потенциальных', async () => {
    const potential = await list({ status: 'all', group: 'potential', limit: '100', q: 'камчатская рыб' });
    expect(potential.data.map((r) => r.id)).toContain(OLD_ID);
    expect(potential.meta.total).toBe(potential.data.length);
    const partners = await list({ status: 'all', group: 'partners', limit: '100', q: 'камчатская рыб' });
    expect(partners.data.map((r) => r.id)).not.toContain(OLD_ID);
    expect(partners.meta.total).toBe(partners.data.length);
  });

  it('% и _ ищутся буквально, а не как «всё подряд»', async () => {
    const percent = await list({ status: 'all', limit: '100', q: '%' });
    expect(percent.meta.total).toBe(0);
    expect(percent.data).toEqual([]);
    const underscore = await list({ status: 'all', limit: '100', q: '_' });
    expect(underscore.meta.total).toBe(0);
  });

  it('страницы складываются ровно в итог, давняя карточка — на одной из них', async () => {
    const first = await list({ status: 'all', limit: '100' });
    const ids = new Set(first.data.map((r) => r.id));
    for (let offset = 100; offset < first.meta.total; offset += 100) {
      const page = await list({ status: 'all', limit: '100', offset: String(offset) });
      for (const r of page.data) ids.add(r.id);
    }
    expect(ids.size).toBe(first.meta.total);
    expect(ids.has(OLD_ID)).toBe(true);
  });
});
