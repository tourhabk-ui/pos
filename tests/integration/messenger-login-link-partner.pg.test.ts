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
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

// ── Миграция 1389: заменена пустой (04.11), упала на проде на заглушке 259dd12b ──
withPg('1389: пустая миграция', () => {
  it('содержит только SELECT 1 — ничего не меняет', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations', '1389_andrey_zaporozhets_account_by_slug.sql'), 'utf-8');
    const body = sql.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim()).join(' ').trim();
    expect(body).toBe('SELECT 1;');
  });
});

// ── Миграция 1390 (04.11): Андрей Запорожец по явным id — точное состояние прода ──
const SQL_1390 = readFileSync(join(process.cwd(), 'migrations', '1390_andrey_zaporozhets_explicit_ids.sql'), 'utf-8');
const UID = '4e2ae003-d54e-4a5d-9604-30d4e948ff09';
const PH = '259dd12b-7025-430e-9baa-254a08a37f39';
const CARD_A = 'd9d1d230-4f18-4917-84f1-59b8fafb11c2';
const CARD_B = '95fe571f-9e99-400e-bdc3-a1682bf3175e';
const MAX_ID = 777_001;
const TG_ID = 221_997_120;

withPg('1390: аккаунт Андрея Запорожца по явным id', () => {
  let pool: import('pg').Pool;
  let dbUrl = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    dbUrl = await createTestDatabase(PG_URL, 'andrey_1390_test');
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '1387_messenger_owner_placeholder_cabinet.sql'), 'utf-8'));
    // Карточку andrey-zaporozhets из 1338 уводим со слага: B ставим с прод-id.
    await pool.query(`UPDATE partners SET slug = 'andrey-zaporozhets-1338' WHERE slug = 'andrey-zaporozhets' AND id::text <> $1`, [CARD_B]);
  }, 300_000);
  afterAll(async () => { await pool?.end().catch(() => undefined); });

  beforeEach(async () => {
    await pool.query(`DELETE FROM operator_bookings WHERE user_id::text = $1 OR operator_tour_id IN (SELECT id FROM operator_tours WHERE operator_id::text IN ($2, $3))`, [PH, CARD_A, CARD_B]);
    await pool.query(`DELETE FROM operator_tours WHERE operator_id::text IN ($1, $2)`, [CARD_A, CARD_B]);
    await pool.query(`DELETE FROM partners WHERE id::text IN ($1, $2) OR user_id::text IN ($3, $4)`, [CARD_A, CARD_B, UID, PH]);
    await pool.query(`DELETE FROM user_sessions WHERE user_id::text IN ($1, $2)`, [UID, PH]);
    await pool.query(`DELETE FROM user_ai_memory WHERE user_id::text IN ($1, $2)`, [UID, PH]);
    await pool.query(`DELETE FROM users WHERE id::text IN ($1, $2)`, [UID, PH]);
    // Аккаунт zap.andy — с паролем, без мессенджеров.
    await pool.query(`INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, 'zap.andy@gmail.com', 'Андрей', 'guide', 'hash')`, [UID]);
    // Заглушка Telegram-входа: держит TG и MAX, есть память Кузьмича и сессия.
    await pool.query(
      `INSERT INTO users (id, email, name, role, password_hash, telegram_id, max_user_id, preferences)
       VALUES ($1, 'tg_221997120@telegram.local', 'Андрей', 'tourist', '', $2, $3, '{}')`, [PH, TG_ID, MAX_ID]);
    await pool.query(`INSERT INTO user_ai_memory (user_id) VALUES ($1)`, [PH]);
    await pool.query(`INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, 'ph-token-1390', NOW() + interval '1 day')`, [PH]);
    // A: пустая из регистрации, аккаунт 4e2ae003, MAX есть, TG нет, скрыта.
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, user_id, is_public, max_owner_user_id)
       VALUES ($1, 'Андрей Запорожец', 'guide', '{}', $2, FALSE, $3)`, [CARD_A, UID, MAX_ID]);
    // B: настоящая, без аккаунта, MAX+TG, публичная.
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, profile_status, status, is_public,
                             max_owner_user_id, telegram_owner_user_id, telegram_chat_id)
       VALUES ($1, 'Андрей Запорожец', 'guide', '{}', 'andrey-zaporozhets', 'approved', 'active', TRUE, $2, $3, $3)`,
      [CARD_B, MAX_ID, TG_ID]);
  });

  // Все NOTICE и текст ошибки последнего прогона — для проверки «MAX id нигде не печатаются».
  let printed: string[] = [];
  async function run(): Promise<void> {
    const c = await pool.connect();
    printed = [];
    const onNotice = (m: { message?: string }) => { printed.push(String(m.message)); };
    c.on('notice', onNotice);
    try { await c.query(SQL_1390); } catch (e) {
      printed.push(String((e as Error).message));
      await c.query('ROLLBACK').catch(() => undefined); throw e;
    } finally { c.off('notice', onNotice); c.release(); }
  }
  const noMaxPrinted = () => { for (const m of printed) expect(m).not.toMatch(/77700\d/); };
  const card = async (id: string) => (await pool.query(
    `SELECT user_id::text, status, is_public, max_owner_user_id::text AS mx FROM partners WHERE id::text = $1`, [id])).rows[0];
  const user = async (id: string) => (await pool.query(
    `SELECT max_user_id::text AS mx, telegram_id::text AS tg, role, is_active FROM users WHERE id::text = $1`, [id])).rows[0];

  it('(1) заглушка с памятью Кузьмича не «пустая» — поэтому 1389 и остановилась', async () => {
    const r = await pool.query(`SELECT vedar_messenger_placeholder_empty($1::uuid) AS ok`, [PH]);
    expect(r.rows[0].ok).toBe(false);
  });

  it('(3) переносит id, выключает заглушку, A — suspended без MAX, B — владелец; повтор без изменений', async () => {
    await run();
    expect(await card(CARD_B)).toMatchObject({ user_id: UID, status: 'active', is_public: true });
    expect(await card(CARD_A)).toMatchObject({ user_id: null, status: 'suspended', is_public: false, mx: null });
    expect(await user(UID)).toEqual({ mx: String(MAX_ID), tg: String(TG_ID), role: 'guide', is_active: true });
    expect(await user(PH)).toEqual({ mx: null, tg: null, role: 'tourist', is_active: false });
    expect((await pool.query(`SELECT count(*)::int AS n FROM user_sessions WHERE user_id::text = $1`, [PH])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM user_ai_memory WHERE user_id::text = $1`, [PH])).rows[0].n).toBe(1);
    await run();
    expect((await card(CARD_B)).user_id).toBe(UID);
  });

  it('(4) после 1390 вход через MAX и Telegram — в аккаунт 4e2ae003', async () => {
    await run();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    vi.resetModules();
    const { linkMessengerLoginToPartner } = await import('@/lib/auth/messenger-link');
    try {
      for (const [ch, col, id] of [['max', 'max_user_id', MAX_ID], ['telegram', 'telegram_id', TG_ID]] as const) {
        const h = (await pool.query(`SELECT id::text AS id, email, name, role FROM users WHERE ${col} = $1 LIMIT 1`, [id])).rows[0] ?? null;
        const got = (await linkMessengerLoginToPartner(ch, id, h)) ?? h;
        expect(got?.id).toBe(UID);
      }
    } finally {
      const { pool: appPool } = await import('@/lib/db-pool');
      await (appPool as unknown as { end?: () => Promise<void> }).end?.();
      process.env.DATABASE_URL = prev;
    }
  });

  it('(5) MAX id на карточках расходятся — стоп с общим текстом, без самих id', async () => {
    await pool.query(`UPDATE partners SET max_owner_user_id = 777002 WHERE id::text = $1`, [CARD_A]);
    await expect(run()).rejects.toThrow(/MAX ids differ/);
    noMaxPrinted();
    expect((await card(CARD_B)).user_id).toBeNull();
  });

  it('(доп.2) успешный прогон: MAX id нет ни в одном NOTICE и бэкапе', async () => {
    await run();
    expect(printed.some((m) => m.includes('BACKUP'))).toBe(true);
    noMaxPrinted();
  });

  it('(доп.1) почта не подтверждена (metadata) — стоп', async () => {
    await pool.query(`UPDATE users SET metadata = '{"email_verified": false}' WHERE id::text = $1`, [UID]);
    await expect(run()).rejects.toThrow(/не подтверждена/);
    expect((await card(CARD_B)).user_id).toBeNull();
  });

  it('(доп.1) почта не подтверждена (колонка email_verified) — стоп; подтверждена — проходит', async () => {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false`);
    try {
      await expect(run()).rejects.toThrow(/не подтверждена/);
      await pool.query(`UPDATE users SET email_verified = TRUE WHERE id::text = $1`, [UID]);
      await run();
      expect((await card(CARD_B)).user_id).toBe(UID);
    } finally {
      await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS email_verified`);
    }
  });

  it('(доп.3) пароль не ставится: без пароля — NOTICE has_password false и не стоп', async () => {
    await pool.query(`UPDATE users SET password_hash = '' WHERE id::text = $1`, [UID]);
    await run();
    expect(printed).toContain('1390: has_password false');
    expect((await pool.query(`SELECT password_hash FROM users WHERE id::text = $1`, [UID])).rows[0].password_hash).toBe('');
    expect((await card(CARD_B)).user_id).toBe(UID);
  });

  it('(доп.3) с паролем — NOTICE has_password true, хэш не тронут', async () => {
    await run();
    expect(printed).toContain('1390: has_password true');
    expect((await pool.query(`SELECT password_hash FROM users WHERE id::text = $1`, [UID])).rows[0].password_hash).toBe('hash');
  });

  it('(доп.4) тур-черновик и бронь карточки A переезжают на B до suspend', async () => {
    // Живые таблицы: operator_tours и operator_bookings (не устаревшие tours/bookings).
    const t = (await pool.query(
      `INSERT INTO operator_tours (operator_id, title, base_price) VALUES ($1, 'Черновик', 100) RETURNING id`, [CARD_A])).rows[0].id;
    const other = (await pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('tourist-1390@example.test', 'T', 'tourist', '') ON CONFLICT DO NOTHING RETURNING id::text`)).rows[0]?.id
      ?? (await pool.query(`SELECT id::text FROM users WHERE email = 'tourist-1390@example.test'`)).rows[0].id;
    await pool.query(`INSERT INTO operator_bookings (operator_tour_id, user_id, booking_date, participants) VALUES ($1, $2, CURRENT_DATE, 1)`, [t, other]);
    await run();
    expect((await pool.query(`SELECT operator_id::text AS op FROM operator_tours WHERE id = $1`, [t])).rows[0].op).toBe(CARD_B);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_tours WHERE operator_id::text = $1`, [CARD_A])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_bookings WHERE operator_tour_id = $1`, [t])).rows[0].n).toBe(1);
    expect(printed.some((m) => /перенесено 1 строк в operator_tours\.operator_id/.test(m))).toBe(true);
    expect((await card(CARD_A)).status).toBe('suspended');
  });

  it('(доп.5) Telegram id: уникальный индекс есть, снятие с заглушки до установки — одной транзакцией', async () => {
    const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND indexdef ILIKE '%UNIQUE%(telegram_id)%'`);
    expect(idx.rowCount).toBeGreaterThan(0);
    const clear = SQL_1390.indexOf('max_user_id = NULL, telegram_id = NULL');
    const set = SQL_1390.indexOf('telegram_id = COALESCE(tg, telegram_id)');
    expect(clear).toBeGreaterThan(0);
    expect(set).toBeGreaterThan(clear);
    expect(SQL_1390.match(/^BEGIN;$/gm)?.length).toBe(1);
    await run();
    expect((await user(UID)).tg).toBe(String(TG_ID));
    expect((await user(PH)).tg).toBeNull();
  });

  it('(доп.5) стоп внутри транзакции — заглушка по-прежнему держит TG, ничего не изменено', async () => {
    await pool.query(`INSERT INTO partners (name, category, contact, user_id) VALUES ('Y', 'operator', '{}', $1)`, [UID]);
    await expect(run()).rejects.toThrow(/ещё карточек/);
    expect((await user(PH)).tg).toBe(String(TG_ID));
  });

  it('(5) у заглушки бронь — стоп (живая таблица operator_bookings)', async () => {
    const t = (await pool.query(`INSERT INTO operator_tours (operator_id, title, base_price) VALUES ($1, 'Тур B', 100) RETURNING id`, [CARD_B])).rows[0].id;
    await pool.query(`INSERT INTO operator_bookings (operator_tour_id, user_id, booking_date, participants) VALUES ($1, $2, CURRENT_DATE, 1)`, [t, PH]);
    await expect(run()).rejects.toThrow(/есть брони/);
    expect((await user(PH)).tg).toBe(String(TG_ID));
  });

  it('(5) у заглушки карточка — стоп', async () => {
    await pool.query(`INSERT INTO partners (name, category, contact, user_id) VALUES ('X', 'operator', '{}', $1)`, [PH]);
    await expect(run()).rejects.toThrow(/есть карточки/);
  });

  it('(5) у карточки B чужой владелец — стоп', async () => {
    const other = (await pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('other-1390@example.test', 'X', 'guide', '') ON CONFLICT DO NOTHING RETURNING id::text`)).rows[0]?.id
      ?? (await pool.query(`SELECT id::text FROM users WHERE email = 'other-1390@example.test'`)).rows[0].id;
    await pool.query(`UPDATE partners SET user_id = $1 WHERE id::text = $2`, [other, CARD_B]);
    await expect(run()).rejects.toThrow(/другой владелец/);
    expect((await card(CARD_A)).status).not.toBe('suspended');
    await pool.query(`UPDATE partners SET user_id = NULL WHERE id::text = $1`, [CARD_B]);
  });
});
