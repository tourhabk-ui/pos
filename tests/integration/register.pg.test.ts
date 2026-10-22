/**
 * Регистрация на настоящем PostgreSQL: POST /api/auth/register.
 *
 * Повод: 20.10 регистрация туриста на проде отвечала 500 «Ошибка
 * регистрации». Мок пула на любой SQL отвечает `{rows: []}` и такой отказ не
 * поймает — здесь INSERT пользователя, партнёрского профиля и строки сессии
 * исполняются на схеме baseline прода + всех миграций.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[register.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'register_test';
let ipSeq = 10;

withPg('регистрация на настоящем PostgreSQL', () => {
  let POST: (req: import('next/server').NextRequest) => Promise<Response>;
  let pool: import('pg').Pool;
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'register-pg-test-secret-0123456789abcdef';
    ({ NextRequest } = await import('next/server'));
    ({ POST } = await import('@/app/api/auth/register/route'));
    ({ pool } = await import('@/lib/database'));
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  function req(body: Record<string, unknown>) {
    ipSeq += 1;
    return new NextRequest('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${ipSeq}` },
      body: JSON.stringify(body),
    });
  }

  const base = { password: 'Vt-test-Passw0rd!', name: 'Тест Турист', pd_consent: true };

  it('турист с «+» в адресе регистрируется: 201, пользователь и сессия в базе', async () => {
    const res = await POST(req({ ...base, email: 'flo+tourist@example.com' }));
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(json.user.role).toBe('tourist');
    const u = await pool.query('SELECT id, role FROM users WHERE email = $1', ['flo+tourist@example.com']);
    expect(u.rows).toHaveLength(1);
    const s = await pool.query('SELECT 1 FROM user_sessions WHERE user_id = $1', [u.rows[0].id]);
    expect(s.rows).toHaveLength(1);
  });

  it('туристу без ролей в форме — тоже 201', async () => {
    const res = await POST(req({ ...base, email: 'plain.tourist@example.com', role: 'tourist' }));
    expect(res.status).toBe(201);
  });

  it('повтор того же адреса — 409, а не 500', async () => {
    const res = await POST(req({ ...base, email: 'plain.tourist@example.com' }));
    expect(res.status).toBe(409);
  });
});
