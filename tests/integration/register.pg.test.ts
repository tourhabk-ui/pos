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

  // Самоназначение администратора (находка 23.10). Список ролей человека —
  // preferences.roles, и по нему switch-role пускает в роль. PUT /api/profile
  // принимал preferences целиком: турист писал себе roles: ['admin'] и
  // следующим запросом входил администратором. Ключи, которые назначает
  // сервер, из профиля больше не пишутся — остальные настройки пишутся как раньше.
  describe('настройки профиля не назначают роли', () => {
    const authed = (url: string, method: string, token: string, body: unknown) =>
      new NextRequest(`http://localhost${url}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    it('турист пишет себе roles: [admin] — роли прежние, войти админом нельзя; прочие настройки сохранены', async () => {
      const reg = await POST(req({ ...base, email: 'self.admin@example.com' }));
      const { token, user } = await reg.json() as { token: string; user: { id: string } };
      const { PUT } = await import('@/app/api/profile/route');
      const { POST: SWITCH } = await import('@/app/api/auth/switch-role/route');

      const put = await PUT(authed('/api/profile', 'PUT', token, {
        preferences: { roles: ['admin'], operator_level: 'L3', force_password_change: false, travelStyle: 'active' },
      }));
      expect(put.status).toBe(200);
      const after = await pool.query<{ role: string; preferences: Record<string, unknown> }>(
        'SELECT role, preferences FROM users WHERE id = $1', [user.id],
      );
      expect(after.rows[0]!.role).toBe('tourist');
      expect(after.rows[0]!.preferences.roles).toEqual(['tourist']);
      expect(after.rows[0]!.preferences).not.toHaveProperty('operator_level');
      expect(after.rows[0]!.preferences).not.toHaveProperty('force_password_change');
      expect(after.rows[0]!.preferences.travelStyle).toBe('active');

      const sw = await SWITCH(authed('/api/auth/switch-role', 'POST', token, { role: 'admin' }));
      expect(sw.status).toBe(403);
      const role = await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [user.id]);
      expect(role.rows[0]!.role).toBe('tourist');
    });

    it('флаг «сменить пароль», поставленный сервером, профилем не снимается', async () => {
      const reg = await POST(req({ ...base, email: 'forced.change@example.com' }));
      const { token, user } = await reg.json() as { token: string; user: { id: string } };
      await pool.query(
        `UPDATE users SET preferences = preferences || '{"force_password_change": true}'::jsonb WHERE id = $1`, [user.id],
      );
      const { PUT } = await import('@/app/api/profile/route');
      const put = await PUT(authed('/api/profile', 'PUT', token, { preferences: { theme: 'dark' } }));
      expect(put.status).toBe(200);
      const after = await pool.query<{ preferences: Record<string, unknown> }>('SELECT preferences FROM users WHERE id = $1', [user.id]);
      expect(after.rows[0]!.preferences).toEqual({ roles: ['tourist'], force_password_change: true, theme: 'dark' });
    });

    it('перепись админов называет записанное до закрытия двери: id, роль и есть ли запись о выдаче — без почт', async () => {
      // Записано раньше дверью профиля: активная роль турист, админ — в собственных.
      const forged = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, role, password_hash, preferences)
         VALUES ('forged.admin@example.com', 'Подделка', 'tourist', 'x', '{"roles":["tourist","admin"]}'::jsonb) RETURNING id::text AS id`,
      );
      // Выдан администратором: роль активна, в журнале role_change.
      const granted = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, role, password_hash, preferences)
         VALUES ('granted.admin@example.com', 'Выдан', 'admin', 'x', '{"roles":["admin"]}'::jsonb) RETURNING id::text AS id`,
      );
      await pool.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, data) VALUES ('user', $1, 'role_change', '{"role":"admin"}'::jsonb)`,
        [granted.rows[0]!.id],
      );
      process.env.CRON_SECRET = process.env.CRON_SECRET || 'admin-census-test-secret';
      const { GET } = await import('@/app/api/cron/admin-owners-census/route');
      const res = await GET(new NextRequest('http://localhost/api/cron/admin-owners-census', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { owners: Array<{ id: string; active_role: string; admin_in_owned: boolean; granted_on_record: boolean }> };
      const byId = new Map(body.owners.map((o) => [o.id, o]));
      expect(byId.get(forged.rows[0]!.id)).toMatchObject({ active_role: 'tourist', admin_in_owned: true, granted_on_record: false });
      expect(byId.get(granted.rows[0]!.id)).toMatchObject({ active_role: 'admin', granted_on_record: true });
      // Туристы без админа в переписи не стоят; почт и имён в ответе нет.
      expect(body.owners).toHaveLength(2);
      expect(JSON.stringify(body)).not.toMatch(/@example\.com|Подделка|Выдан/);

      const denied = await GET(new NextRequest('http://localhost/api/cron/admin-owners-census'));
      expect(denied.status).toBe(401);
    });
  });
});
