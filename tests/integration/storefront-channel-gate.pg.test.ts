/**
 * Канал уведомлений до витрины — на настоящем PostgreSQL (план готовности
 * 23.11, этап 3b).
 *
 * Заявка туриста уходит партнёру в MAX или Telegram. Партнёр на витрине без
 * привязанного чата её не получит. До этого дня двери администратора канал
 * не спрашивали: одобрение ставило карточку на витрину сразу.
 *
 * Здесь судятся сами двери на схеме прода — настоящий `reachForPartner`
 * читает `partners.max_chat_id`, `partners.telegram_chat_id` и
 * `users.telegram_id`:
 *  - одобрение без канала — 409, карточка не изменена; с MAX или Telegram —
 *    одобрена и на витрине;
 *  - уже стоящего на витрине пилота без канала правило не запирает;
 *  - агента и тестовый профиль одобрение на витрину не ставит — им канал не
 *    спрашивается;
 *  - правка карточки: впервые на витрину без канала — 409; снятие с витрины
 *    и правка стоящей — как прежде;
 *  - новая карточка сразу на витрину — 409, строки в базе нет; ресторану
 *    заявки не приходят — можно.
 *
 * Своя база `storefront_channel_gate_test`. Без KERNEL_PG_TEST_URL файл
 * честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const ADMIN_ID = 'c3300000-0000-4000-8000-0000000000ad';
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'c3300000-0000-4000-8000-0000000000ad', role: 'admin' })), // = ADMIN_ID
}));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: vi.fn(async () => undefined) } }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[storefront-channel-gate.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'storefront_channel_gate_test';

type Card = {
  key: string; category: string; profileStatus: string; isPublic: boolean; isTest?: boolean;
  max?: number; telegram?: number; userTelegram?: number;
};
const CARDS: Card[] = [
  { key: 'noChannel',  category: 'operator', profileStatus: 'pending', isPublic: false },
  { key: 'withMax',    category: 'operator', profileStatus: 'pending', isPublic: false, max: 700001 },
  { key: 'withTg',     category: 'guide',    profileStatus: 'pending', isPublic: false, telegram: 700002 },
  { key: 'userTg',     category: 'transfer', profileStatus: 'pending', isPublic: false, userTelegram: 700003 },
  { key: 'pilot',      category: 'operator', profileStatus: 'pending', isPublic: true },
  { key: 'agent',      category: 'agent',    profileStatus: 'pending', isPublic: false },
  { key: 'stand',      category: 'operator', profileStatus: 'pending', isPublic: false, isTest: true },
  { key: 'editHidden', category: 'operator', profileStatus: 'approved', isPublic: false },
  { key: 'editBound',  category: 'transfer', profileStatus: 'approved', isPublic: false, max: 700004 },
  { key: 'editPublic', category: 'operator', profileStatus: 'approved', isPublic: true },
  { key: 'cafePublic', category: 'restaurant', profileStatus: 'approved', isPublic: true },
  { key: 'cafeBound',  category: 'restaurant', profileStatus: 'approved', isPublic: true, max: 700005 },
];
const idOf = (i: number) => `c3300000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
const userOf = (i: number) => `c3300000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`;
const ID = Object.fromEntries(CARDS.map((c, i) => [c.key, idOf(i)])) as Record<string, string>;

withPg('канал уведомлений до витрины: двери администратора', () => {
  let pool: import('pg').Pool;
  let dbUrl = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    delete process.env.TELEGRAM_BOT_TOKEN;

    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'gate-admin@example.test', 'Администратор', 'x', 'admin')`,
      [ADMIN_ID],
    );
    for (const [i, c] of CARDS.entries()) {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role, telegram_id) VALUES ($1, $2, 'Тест', 'x', 'operator', $3)`,
        [userOf(i), `gate-${c.key.toLowerCase()}@example.test`, c.userTelegram ?? null],
      );
      await pool.query(
        `INSERT INTO partners (id, user_id, name, category, contact, profile_status, is_public, is_test, max_chat_id, telegram_chat_id)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, $8, $9)`,
        [idOf(i), userOf(i), `Канал ${c.key}`, c.category, c.profileStatus, c.isPublic, c.isTest === true, c.max ?? null, c.telegram ?? null],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
  });

  const state = async (key: string) => (await pool.query<{ is_public: boolean | null; profile_status: string; is_verified: boolean | null; name: string }>(
    `SELECT is_public, profile_status, is_verified, name FROM partners WHERE id = $1`, [ID[key]],
  )).rows[0];

  const approve = async (key: string) => {
    const { PATCH } = await import('@/app/api/admin/operators/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/admin/operators/${ID[key]}`, { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }),
      { params: Promise.resolve({ id: ID[key] }) },
    );
    return { status: res.status, body: await res.json() as { success?: boolean; error?: string; code?: string } };
  };

  const edit = async (key: string, body: Record<string, unknown>) => {
    const { PUT } = await import('@/app/api/admin/content/partners/[id]/route');
    const res = await PUT(
      new NextRequest(`http://localhost/api/admin/content/partners/${ID[key]}`, { method: 'PUT', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: ID[key] }) },
    );
    return { status: res.status, body: await res.json() as { success?: boolean; error?: string; code?: string } };
  };

  describe('одобрение', () => {
    it('без MAX и Telegram — 409 словами, карточка не изменена', async () => {
      const { NO_CHANNEL_TEXT } = await import('@/lib/partners/storefront-gate');
      const r = await approve('noChannel');
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ success: false, error: NO_CHANNEL_TEXT, code: 'no_channel' });
      expect(await state('noChannel')).toMatchObject({ is_public: false, profile_status: 'pending' });
    });

    it.each([['withMax', 'MAX'], ['withTg', 'Telegram карточки'], ['userTg', 'Telegram аккаунта']])(
      'с каналом (%s — %s) — одобрена и на витрине', async (key) => {
        const r = await approve(key);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.success).toBe(true);
        expect(await state(key)).toMatchObject({ is_public: true, profile_status: 'approved', is_verified: true });
      },
    );

    it('пилот уже на витрине, канала нет — правило его не запирает', async () => {
      const r = await approve('pilot');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await state('pilot')).toMatchObject({ is_public: true, profile_status: 'approved' });
    });

    it('агента одобрение на витрину не ставит — канал не спрашивается', async () => {
      const r = await approve('agent');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await state('agent')).toMatchObject({ is_public: false, profile_status: 'approved' });
    });

    it('тестовый профиль одобрение на витрину не ставит — канал не спрашивается', async () => {
      const r = await approve('stand');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await state('stand')).toMatchObject({ is_public: false, profile_status: 'approved' });
    });
  });

  describe('правка карточки', () => {
    it('впервые на витрину без канала — 409, карточка не изменена', async () => {
      const { NO_CHANNEL_TEXT } = await import('@/lib/partners/storefront-gate');
      const r = await edit('editHidden', { name: 'Канал editHidden (новое имя)', isPublic: true });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ success: false, error: NO_CHANNEL_TEXT, code: 'no_channel' });
      expect(await state('editHidden')).toMatchObject({ is_public: false, name: 'Канал editHidden' });
    });

    it('без постановки на витрину правка проходит — имя меняется', async () => {
      const r = await edit('editHidden', { name: 'Канал editHidden (правка)' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await state('editHidden')).toMatchObject({ is_public: false, name: 'Канал editHidden (правка)' });
    });

    it('с каналом — на витрину можно', async () => {
      const r = await edit('editBound', { name: 'Канал editBound', isPublic: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await state('editBound')).is_public).toBe(true);
    });

    it('карточка уже на витрине без канала: правка проходит, снятие с витрины — тоже', async () => {
      const keep = await edit('editPublic', { name: 'Канал editPublic (правка)', isPublic: true });
      expect(keep.status, JSON.stringify(keep.body)).toBe(200);
      expect(await state('editPublic')).toMatchObject({ is_public: true, name: 'Канал editPublic (правка)' });
      const off = await edit('editPublic', { name: 'Канал editPublic (правка)', isPublic: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect((await state('editPublic')).is_public).toBe(false);
    });

    it('ресторан на витрине правкой становится туроператором: без канала — 409, с каналом — можно', async () => {
      const { NO_CHANNEL_TEXT } = await import('@/lib/partners/storefront-gate');
      const category = async (key: string) => (await pool.query<{ category: string }>(`SELECT category FROM partners WHERE id = $1`, [ID[key]])).rows[0].category;
      // Ресторану канал не нужен — он на витрине и без него. Туроператору — нужен.
      const denied = await edit('cafePublic', { name: 'Канал cafePublic', category: 'operator' });
      expect(denied.status).toBe(409);
      expect(denied.body).toEqual({ success: false, error: NO_CHANNEL_TEXT, code: 'no_channel' });
      expect(await category('cafePublic')).toBe('restaurant');
      // То же при явном isPublic: true — «уже на витрине» правило не обходит.
      expect((await edit('cafePublic', { name: 'Канал cafePublic', category: 'operator', isPublic: true })).status).toBe(409);
      expect(await category('cafePublic')).toBe('restaurant');
      // Имя ресторана править можно: заявок он не принимает.
      expect((await edit('cafePublic', { name: 'Канал cafePublic (правка)' })).status).toBe(200);
      const ok = await edit('cafeBound', { name: 'Канал cafeBound', category: 'operator' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await category('cafeBound')).toBe('operator');
    });

    it('снятую без канала обратно на витрину не поставить', async () => {
      const back = await edit('editPublic', { name: 'Канал editPublic (правка)', isPublic: true });
      expect(back.status).toBe(409);
      expect((await state('editPublic')).is_public).toBe(false);
    });
  });

  describe('новая карточка', () => {
    const create = async (body: Record<string, unknown>) => {
      const { POST } = await import('@/app/api/admin/content/partners/route');
      const res = await POST(new NextRequest('http://localhost/api/admin/content/partners', { method: 'POST', body: JSON.stringify(body) }));
      return { status: res.status, body: await res.json() as { success?: boolean; error?: string; code?: string } };
    };
    const exists = async (slug: string) => (await pool.query(`SELECT 1 FROM partners WHERE slug = $1`, [slug])).rowCount;

    it('сразу на витрину — 409, строки в базе нет', async () => {
      const { NEW_CARD_NOT_PUBLIC_TEXT } = await import('@/lib/partners/storefront-gate');
      const r = await create({ name: 'Канал новая', slug: 'gate-new-public', category: 'operator', contact: { phone: '+70000000000' }, isPublic: true });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ success: false, error: NEW_CARD_NOT_PUBLIC_TEXT, code: 'no_channel' });
      expect(await exists('gate-new-public')).toBe(0);
    });

    it('не на витрину — заводится, как прежде', async () => {
      const r = await create({ name: 'Канал новая скрытая', slug: 'gate-new-hidden', category: 'transfer', contact: { phone: '+70000000000' } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await exists('gate-new-hidden')).toBe(1);
    });

    it('ресторану заявки не приходят — сразу на витрину можно', async () => {
      const r = await create({ name: 'Канал ресторан', slug: 'gate-new-restaurant', category: 'restaurant', contact: { phone: '+70000000000' }, isPublic: true });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await exists('gate-new-restaurant')).toBe(1);
    });
  });
});
