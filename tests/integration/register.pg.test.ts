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

    /** Пользователь прямо в базе — с ролью, собственными ролями и, если нужно, живой сессией. */
    async function seedUser(email: string, role: string, roles: string[], withSession = false): Promise<{ id: string; token: string | null }> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, role, password_hash, preferences)
         VALUES ($1, 'Тест', $2, 'x', jsonb_build_object('roles', $3::jsonb)) RETURNING id::text AS id`,
        [email, role, JSON.stringify(roles)],
      );
      const id = r.rows[0]!.id;
      if (!withSession) return { id, token: null };
      const { createToken } = await import('@/lib/auth/jwt');
      const { recordUserSession } = await import('@/lib/auth/session-record');
      const token = await createToken({ userId: id, email, role });
      await recordUserSession(pool, id, token);
      return { id, token };
    }
    const audit = (id: string, action: string, data: Record<string, unknown>, at: string) => pool.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, data, created_at) VALUES ('user', $1, $2, $3::jsonb, $4::timestamptz)`,
      [id, action, JSON.stringify(data), at],
    );

    it('снятый в админке админ теряет его и в собственных ролях, его сессии отозваны, смена в журнале', async () => {
      const actor = await seedUser('actor.admin@example.com', 'admin', ['admin'], true);
      const demoted = await seedUser('demoted.admin@example.com', 'admin', ['tourist', 'admin'], true);
      const { PATCH } = await import('@/app/api/admin/users/[id]/route');
      const { POST: SWITCH } = await import('@/app/api/auth/switch-role/route');

      const res = await PATCH(authed(`/api/admin/users/${demoted.id}`, 'PATCH', actor.token!, { role: 'tourist' }),
        { params: Promise.resolve({ id: demoted.id }) });
      expect(res.status).toBe(200);
      const row = await pool.query<{ role: string; preferences: { roles: string[] } }>('SELECT role, preferences FROM users WHERE id = $1', [demoted.id]);
      expect(row.rows[0]).toMatchObject({ role: 'tourist', preferences: { roles: ['tourist'] } });
      const sessions = await pool.query('SELECT 1 FROM user_sessions WHERE user_id = $1', [demoted.id]);
      expect(sessions.rows).toHaveLength(0);
      const log = await pool.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_log WHERE entity_id = $1 AND action = 'role_change'`, [demoted.id],
      );
      expect(log.rows.map((r) => r.data)).toEqual([{ role: 'tourist', from: 'admin', changedBy: actor.id, sessions_revoked: 1 }]);

      // Старый токен больше не пускает никуда — вернуть себе админа нечем.
      const back = await SWITCH(authed('/api/auth/switch-role', 'POST', demoted.token!, { role: 'admin' }));
      expect(back.status).toBe(401);

      // Назначение админа кладёт его в собственные роли и пишется с автором.
      const promoted = await seedUser('promoted.admin@example.com', 'tourist', ['tourist']);
      const up = await PATCH(authed(`/api/admin/users/${promoted.id}`, 'PATCH', actor.token!, { role: 'admin' }),
        { params: Promise.resolve({ id: promoted.id }) });
      expect(up.status).toBe(200);
      const prow = await pool.query<{ role: string; preferences: { roles: string[] } }>('SELECT role, preferences FROM users WHERE id = $1', [promoted.id]);
      expect(prow.rows[0]).toMatchObject({ role: 'admin', preferences: { roles: ['tourist', 'admin'] } });
    });

    it('перепись админов называет записанное до закрытия двери: признаки по журналу, итоги сходятся, без почт', async () => {
      // Записано дверью профиля и использовано: первый переход — из туриста в админа.
      const forgedSwitched = await seedUser('forged.switched@example.com', 'admin', ['tourist', 'admin']);
      await audit(forgedSwitched.id, 'role_switch', { from: 'tourist', to: 'admin' }, '2026-10-20T10:00:00Z');
      // Записано и не использовано: активная роль турист.
      const forgedIdle = await seedUser('forged.idle@example.com', 'tourist', ['tourist', 'admin']);
      // «Выдал сам себе» — запись о выдаче есть, но автор — он сам.
      const forgedSelf = await seedUser('forged.self@example.com', 'admin', ['admin']);
      await audit(forgedSelf.id, 'role_change', { role: 'admin', changedBy: forgedSelf.id }, '2026-10-20T11:00:00Z');
      // Владелец до журнала: админ ДО первого переключения.
      const owner = await seedUser('owner.seed@example.com', 'operator', ['admin', 'operator']);
      await audit(owner.id, 'role_switch', { from: 'admin', to: 'operator' }, '2026-09-01T10:00:00Z');
      await audit(owner.id, 'role_switch', { from: 'operator', to: 'admin' }, '2026-09-02T10:00:00Z');

      process.env.CRON_SECRET = process.env.CRON_SECRET || 'admin-census-test-secret';
      const { GET } = await import('@/app/api/cron/admin-owners-census/route');
      const res = await GET(new NextRequest('http://localhost/api/cron/admin-owners-census', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }));
      expect(res.status).toBe(200);
      type Owner = { id: string; active_role: string; admin_in_owned: boolean; granted_on_record: boolean; granted_by_self: boolean;
        admin_before_any_switch: boolean | null; first_switch_to_admin_at: string | null };
      const body = await res.json() as { owners_total: number; without_grant_on_record: number; owners: Owner[] };
      const byId = new Map(body.owners.map((o) => [o.id, o]));

      expect(byId.get(forgedSwitched.id)).toMatchObject({
        active_role: 'admin', granted_on_record: false, granted_by_self: false, admin_before_any_switch: false,
      });
      expect(byId.get(forgedSwitched.id)!.first_switch_to_admin_at).not.toBeNull();
      expect(byId.get(forgedIdle.id)).toMatchObject({
        active_role: 'tourist', admin_in_owned: true, granted_on_record: false, admin_before_any_switch: null, first_switch_to_admin_at: null,
      });
      expect(byId.get(forgedSelf.id)).toMatchObject({ granted_on_record: false, granted_by_self: true });
      expect(byId.get(owner.id)).toMatchObject({ active_role: 'operator', admin_in_owned: true, admin_before_any_switch: true });

      // Выданный в админке (предыдущая проверка) — с записью другого автора; снятый — вне переписи.
      const promoted = await pool.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE email = 'promoted.admin@example.com'`);
      expect(byId.get(promoted.rows[0]!.id)).toMatchObject({ granted_on_record: true, granted_by_self: false });
      const gone = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE email IN ('demoted.admin@example.com', 'self.admin@example.com')`,
      );
      for (const g of gone.rows) expect(byId.has(g.id)).toBe(false);

      // Итоги — из тех же строк, что в списке.
      expect(body.owners_total).toBe(body.owners.length);
      expect(body.without_grant_on_record).toBe(body.owners.filter((o) => !o.granted_on_record).length);
      expect(JSON.stringify(body)).not.toMatch(/@example\.com|Тест/);

      const denied = await GET(new NextRequest('http://localhost/api/cron/admin-owners-census'));
      expect(denied.status).toBe(401);
    });
  });
});
