/**
 * Вход через MAX/Telegram находит кабинет партнёра (03.11, миграция 1386).
 * Оператор подключил бота (MAX/Telegram записан в partners), а вход на сайт
 * создавал пустого туриста max_<id>@max.local. Против базы со схемой прода:
 *   - id свободен, владелец один → вход в аккаунт владельца;
 *   - id держит пустой дубль → id переносится, дубль выключен;
 *   - у дубля есть данные → не трогаем;
 *   - два владельца → не связываем;
 *   - разовый перенос миграции идемпотентен.
 * Без KERNEL_PG_TEST_URL файл честно пропускается.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
const TEST_DB = 'messenger_login_link_test';

withPg('вход через мессенджер → кабинет партнёра (1386)', () => {
  let pool: import('pg').Pool;
  let n = 0;

  async function user(email: string, role: string, extra: Record<string, unknown> = {}): Promise<string> {
    const cols = ['email', 'name', 'role', 'password_hash', ...Object.keys(extra)];
    const vals = [email, 'Тест', role, '', ...Object.values(extra)];
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      vals,
    );
    return r.rows[0].id;
  }
  async function partner(userId: string, set: Record<string, unknown>): Promise<void> {
    n += 1;
    const cols = ['name', 'category', 'contact', 'user_id', ...Object.keys(set)];
    const vals = [`Оператор ${n}`, 'operator', JSON.stringify({ email: `op${n}@example.test` }), userId, ...Object.values(set)];
    await pool.query(
      `INSERT INTO partners (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals,
    );
  }
  const row = async (id: string) =>
    (await pool.query<{ max_user_id: string | null; telegram_id: string | null; is_active: boolean }>(
      `SELECT max_user_id::text, telegram_id::text, is_active FROM users WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    // Функции 1387 (владелец-заглушка с кабинетом) — поверх 1386 из схемы.
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '1387_messenger_owner_placeholder_cabinet.sql'), 'utf-8'));
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('MAX: id свободен, владелец один → вход в кабинет оператора', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const op = await user('op-a@example.test', 'operator');
    await partner(op, { max_owner_user_id: 820_001 });
    const linked = await linkMessengerLoginToPartner('max', 820_001, null);
    expect(linked?.id).toBe(op);
    expect(linked?.role).toBe('operator');
    expect((await row(op)).max_user_id).toBe('820001');
  });

  it('MAX: пустой дубль держит id → id у оператора, дубль выключен', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const op = await user('op-b@example.test', 'operator');
    await partner(op, { max_owner_user_id: 820_002 });
    const dup = await user('max_820002@max.local', 'tourist', { max_user_id: 820_002 });
    const linked = await linkMessengerLoginToPartner('max', 820_002, { id: dup });
    expect(linked?.id).toBe(op);
    expect(await row(dup)).toMatchObject({ max_user_id: null, is_active: false });
  });

  it('Telegram: дубль с данными не трогаем', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const op = await user('op-c@example.test', 'operator');
    await partner(op, { telegram_chat_id: 820_003 });
    const dup = await user('tg_820003@telegram.local', 'tourist', { telegram_id: 820_003 });
    // Любая строка со ссылкой на users, кроме служебных, — «данные».
    const other = await user('op-c2@example.test', 'operator');
    await partner(other, {});
    await pool.query(
      `INSERT INTO operator_members (partner_id, user_id, status, revoked_at)
       SELECT id, $1, 'revoked', NOW() FROM partners WHERE user_id = $2`, [dup, other]);
    const linked = await linkMessengerLoginToPartner('telegram', 820_003, { id: dup });
    expect(linked).toBeNull();
    expect((await row(dup)).telegram_id).toBe('820003');
    expect((await row(op)).telegram_id).toBeNull();
  });

  it('два владельца → не связываем', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const a = await user('op-d1@example.test', 'operator');
    const b = await user('op-d2@example.test', 'guide');
    await partner(a, { max_owner_user_id: 820_004 });
    await partner(b, { max_owner_user_id: 820_004 });
    expect(await linkMessengerLoginToPartner('max', 820_004, null)).toBeNull();
    expect((await row(a)).max_user_id).toBeNull();
  });

  it('разовый перенос 1386 переносит пустой дубль и идемпотентен', async () => {
    const op = await user('op-e@example.test', 'operator');
    await partner(op, { max_owner_user_id: 820_005 });
    const dup = await user('max_820005@max.local', 'tourist', { max_user_id: 820_005 });
    const sql = readFileSync(join(process.cwd(), 'migrations', '1386_messenger_login_link_partner.sql'), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query(sql);
      expect((await row(op)).max_user_id).toBe('820005');
      expect(await row(dup)).toMatchObject({ max_user_id: null, is_active: false });
      await client.query(sql);
      expect((await row(op)).max_user_id).toBe('820005');
    } finally {
      client.release();
    }
  });
  // 1387: кабинет на аккаунте-заглушке (гид без почты, подключён через бота).
  it('1387: MAX-id на пустом туристе, кабинет на TG-заглушке гида → вход в кабинет', async () => {
    // Тест разового переноса 1386 выше переопределяет функции версией 1386.
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '1387_messenger_owner_placeholder_cabinet.sql'), 'utf-8'));
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const guide = await user('tg_830001@telegram.local', 'guide', { telegram_id: 830_001 });
    await partner(guide, { max_owner_user_id: 830_101, telegram_chat_id: 830_001 });
    const dup = await user('max_830101@max.local', 'tourist', { max_user_id: 830_101 });
    const linked = await linkMessengerLoginToPartner('max', 830_101, { id: dup });
    expect(linked?.id).toBe(guide);
    expect((await row(guide))).toMatchObject({ max_user_id: '830101', telegram_id: '830001', is_active: true });
    expect(await row(dup)).toMatchObject({ max_user_id: null, is_active: false });
  });

  it('1387: пустой турист-заглушка владельцем не считается', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const op = await user('max_830002@max.local', 'tourist', { max_user_id: 830_002 });
    expect(await linkMessengerLoginToPartner('max', 830_002, { id: op })).toBeNull();
    expect((await row(op))).toMatchObject({ max_user_id: '830002', is_active: true });
  });

  it('1387: у владельца уже другой MAX → дубль не выключаем', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const guide = await user('tg_830003@telegram.local', 'guide', { max_user_id: 830_999 });
    await partner(guide, { max_owner_user_id: 830_103 });
    const dup = await user('max_830103@max.local', 'tourist', { max_user_id: 830_103 });
    expect(await linkMessengerLoginToPartner('max', 830_103, { id: dup })).toBeNull();
    expect(await row(dup)).toMatchObject({ max_user_id: '830103', is_active: true });
  });

  it('1387: разовый перенос на заглушку-гида, идемпотентен, гида не выключает', async () => {
    const guide = await user('tg_830004@telegram.local', 'guide', { telegram_id: 830_004 });
    await partner(guide, { max_owner_user_id: 830_104 });
    const dup = await user('max_830104@max.local', 'tourist', { max_user_id: 830_104 });
    const sql = readFileSync(join(process.cwd(), 'migrations', '1387_messenger_owner_placeholder_cabinet.sql'), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query(sql);
      expect(await row(guide)).toMatchObject({ max_user_id: '830104', is_active: true });
      expect(await row(dup)).toMatchObject({ max_user_id: null, is_active: false });
      await client.query(sql);
      expect(await row(guide)).toMatchObject({ max_user_id: '830104', is_active: true });
    } finally {
      client.release();
    }
  });
  it('04.11: карточка без аккаунта, MAX подключён владельцем → вход заводит кабинет', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    await partner(null as unknown as string, { max_owner_user_id: 830_201 });
    const linked = await linkMessengerLoginToPartner('max', 830_201, null);
    expect(linked?.role).toBe('operator');
    expect((await row(linked!.id)).max_user_id).toBe('830201');
    const owner = await pool.query(`SELECT user_id::text FROM partners WHERE max_owner_user_id = 830201`);
    expect(owner.rows[0].user_id).toBe(linked!.id);
  });

  it('04.11: пустой турист держит MAX, карточка без аккаунта → тот же аккаунт получает роль, никто не выключен', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    const t = await user('max_830202@max.local', 'tourist', { max_user_id: 830_202 });
    await partner(null as unknown as string, { max_owner_user_id: 830_202 });
    const linked = await linkMessengerLoginToPartner('max', 830_202, { id: t });
    expect(linked?.id).toBe(t);
    expect(linked?.role).toBe('operator');
    expect(await row(t)).toMatchObject({ max_user_id: '830202', is_active: true });
  });

  it('04.11: две карточки без аккаунта на один MAX → не связываем', async () => {
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    await partner(null as unknown as string, { max_owner_user_id: 830_203 });
    await partner(null as unknown as string, { max_owner_user_id: 830_203 });
    expect(await linkMessengerLoginToPartner('max', 830_203, null)).toBeNull();
  });

});

// ── Миграция 1390 (04.11): аккаунт Андрея Запорожца по явным id (1389 — пустая) ──
const SQL_1389 = readFileSync(join(process.cwd(), 'migrations', '1389_andrey_zaporozhets_account_by_slug.sql'), 'utf-8');
const SQL_1390 = readFileSync(join(process.cwd(), 'migrations', '1390_andrey_zaporozhets_explicit_ids.sql'), 'utf-8');
const PH = '259dd12b-7025-430e-9baa-254a08a37f39';
const UID = '4e2ae003-d54e-4a5d-9604-30d4e948ff09';

withPg('1390: карточка Андрея Запорожца получает аккаунт', () => {
  let pool: import('pg').Pool;
  let real = '';
  let empty = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: await createTestDatabase(PG_URL, 'andrey_1390_test'), max: 2 });
  }, 300_000);
  afterAll(async () => { await pool?.end().catch(() => undefined); });

  beforeEach(async () => {
    await pool.query(`UPDATE partners SET user_id = NULL WHERE slug = 'andrey-zaporozhets'`);
    await pool.query(`DELETE FROM partners WHERE name = 'Андрей Запорожец' AND slug IS DISTINCT FROM 'andrey-zaporozhets'`);
    await pool.query(`DELETE FROM user_sessions WHERE user_id::text IN ($1, $2)`, [PH, UID]);
    await pool.query(`DELETE FROM users WHERE id::text IN ($1, $2)`, [PH, UID]);
    await pool.query(
      `INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, 'zap.andy@gmail.com', 'Андрей', 'guide', '')`, [UID]);
    await pool.query(
      `INSERT INTO users (id, email, name, role, password_hash, max_user_id, telegram_id)
       VALUES ($1, 'tg_221997120@telegram.local', 'Андрей', 'tourist', '', 777001, 221997120)`, [PH]);
    const ex = await pool.query<{ id: string }>(`SELECT id::text FROM partners WHERE slug = 'andrey-zaporozhets'`);
    real = ex.rows[0]?.id ?? (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, slug) VALUES ('Андрей Запорожец', 'guide', '{}', 'andrey-zaporozhets') RETURNING id::text`)).rows[0].id;
    await pool.query(
      `UPDATE partners SET category = 'guide', profile_status = 'approved', status = 'active', is_public = TRUE,
              max_owner_user_id = 777001, telegram_owner_user_id = 221997120 WHERE id::text = $1`, [real]);
    empty = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, profile_status, is_public, max_owner_user_id)
       VALUES ('Андрей Запорожец', 'guide', '{}', $1, 'pending', FALSE, 777001) RETURNING id::text`, [UID])).rows[0].id;
  });

  async function run(sql = SQL_1390): Promise<void> {
    const c = await pool.connect();
    try { await c.query(sql); } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const card = async (id: string) => (await pool.query<{ user_id: string | null; status: string | null; is_public: boolean }>(
    `SELECT user_id::text, status, is_public FROM partners WHERE id::text = $1`, [id])).rows[0];
  const user = async (id: string) => (await pool.query(
    `SELECT max_user_id::text AS mx, telegram_id::text AS tg, role, is_active FROM users WHERE id::text = $1`, [id])).rows[0];

  it('1389 теперь пустая и ничего не меняет', async () => {
    await run(SQL_1389);
    expect((await card(real)).user_id).toBeNull();
    expect((await user(PH)).mx).toBe('777001');
  });

  it('переносит id с заглушки, выключает её, привязывает, пустую — suspended; повтор без изменений', async () => {
    await run();
    expect((await card(real)).user_id).toBe(UID);
    expect(await card(empty)).toMatchObject({ user_id: null, status: 'suspended', is_public: false });
    expect(await user(UID)).toMatchObject({ mx: '777001', tg: '221997120', role: 'guide' });
    expect(await user(PH)).toMatchObject({ mx: null, tg: null, is_active: false });
    await run();
    expect((await card(real)).user_id).toBe(UID);
  });

  it('у заглушки есть карточка — стоп, ничего не тронуто', async () => {
    await pool.query(`INSERT INTO partners (name, category, contact, user_id) VALUES ('X', 'guide', '{}', $1)`, [PH]);
    await expect(run()).rejects.toThrow(/есть карточки/);
    expect((await user(PH)).mx).toBe('777001');
    await pool.query(`DELETE FROM partners WHERE user_id::text = $1`, [PH]);
  });

  it('у карточки по слагу чужой владелец — стоп', async () => {
    await pool.query(`UPDATE partners SET user_id = $1 WHERE id::text = $2`, [PH, real]);
    await expect(run()).rejects.toThrow(/другой владелец/);
    expect((await card(empty)).status).not.toBe('suspended');
  });
});
