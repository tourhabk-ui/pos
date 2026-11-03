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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});
