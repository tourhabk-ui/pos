/**
 * Миграция 1389: аккаунт zap.andy@gmail.com — владелец карточки andrey-zaporozhets,
 * пустая карточка из регистрации — suspended; неоднозначность — стоп.
 * Без KERNEL_PG_TEST_URL файл пропускается.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
const SQL = readFileSync(join(process.cwd(), 'migrations', '1389_andrey_zaporozhets_account_by_slug.sql'), 'utf-8');

withPg('1389: карточка Андрея Запорожца получает аккаунт', () => {
  let pool: import('pg').Pool;
  let uid = '';
  let real = '';
  let empty = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: await createTestDatabase(PG_URL, 'andrey_1389_test'), max: 2 });
  }, 300_000);
  afterAll(async () => { await pool?.end().catch(() => undefined); });

  beforeEach(async () => {
    await pool.query(`DELETE FROM operator_applications WHERE partner_id IN (SELECT id FROM partners WHERE name = 'Андрей Запорожец')`);
    await pool.query(`DELETE FROM partners WHERE name = 'Андрей Запорожец'`);
    await pool.query(`DELETE FROM users WHERE email IN ('zap.andy@gmail.com', 'max_777001@max.local')`);
    uid = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash) VALUES ('zap.andy@gmail.com', 'Андрей', 'guide', '') RETURNING id::text`)).rows[0].id;
    real = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, slug, profile_status, status, is_public, max_owner_user_id, telegram_owner_user_id)
       VALUES ('Андрей Запорожец', 'guide', '{}', 'andrey-zaporozhets', 'approved', 'active', TRUE, 777001, 888001) RETURNING id::text`)).rows[0].id;
    empty = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, profile_status, is_public, max_owner_user_id)
       VALUES ('Андрей Запорожец', 'guide', '{}', $1, 'pending', FALSE, 777001) RETURNING id::text`, [uid])).rows[0].id;
  });

  async function run(): Promise<void> {
    const c = await pool.connect();
    try { await c.query(SQL); } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const card = async (id: string) => (await pool.query<{ user_id: string | null; status: string | null; is_public: boolean }>(
    `SELECT user_id::text, status, is_public FROM partners WHERE id::text = $1`, [id])).rows[0];

  it('привязывает, переносит id, пустую — suspended; повтор без изменений', async () => {
    await run();
    expect((await card(real)).user_id).toBe(uid);
    expect(await card(empty)).toMatchObject({ user_id: null, status: 'suspended', is_public: false });
    const u = (await pool.query(`SELECT max_user_id::text AS mx, telegram_id::text AS tg, role FROM users WHERE id::text = $1`, [uid])).rows[0];
    expect(u).toEqual({ mx: '777001', tg: '888001', role: 'guide' });
    await run();
    expect((await card(real)).user_id).toBe(uid);
  });

  it('пустой турист-дубль с MAX id выключается', async () => {
    const dup = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash, max_user_id) VALUES ('max_777001@max.local', 'MAX', 'tourist', '', 777001) RETURNING id::text`)).rows[0].id;
    await run();
    const d = (await pool.query(`SELECT max_user_id, is_active FROM users WHERE id::text = $1`, [dup])).rows[0];
    expect(d).toEqual({ max_user_id: null, is_active: false });
  });

  it('у карточки по слагу чужой аккаунт — стоп, ничего не тронуто', async () => {
    const other = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash) VALUES ('max_777001@max.local', 'X', 'guide', '') RETURNING id::text`)).rows[0].id;
    await pool.query(`UPDATE partners SET user_id = $1 WHERE id::text = $2`, [other, real]);
    await expect(run()).rejects.toThrow(/другой аккаунт/);
    expect((await card(empty)).status).not.toBe('suspended');
  });

  it('у пустой карточки описание — стоп', async () => {
    await pool.query(`UPDATE partners SET description = 'текст' WHERE id::text = $1`, [empty]);
    await expect(run()).rejects.toThrow(/не пустая/);
    expect((await card(real)).user_id).toBeNull();
  });
});
