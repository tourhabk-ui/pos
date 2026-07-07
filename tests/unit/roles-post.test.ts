/**
 * tests/unit/roles-post.test.ts
 *
 * POST /api/roles больше не заглушка:
 * - реально обновляет users.role и добавляет роль в preferences.roles;
 * - несуществующий пользователь → 404;
 * - партнёрская роль → создаётся partners-профиль (ensurePartnerForRole);
 * - tourist → без партнёрского профиля;
 * - PATCH /api/admin/users/[id] принимает все роли платформы (stay/gear/...)
 *   и тоже создаёт партнёрский профиль.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '10.0.0.1',
}));

import { POST as postRole } from '@/app/api/roles/route';
import { PATCH as patchAdminUser } from '@/app/api/admin/users/[id]/route';

const USER_ID = '55555555-5555-4555-8555-555555555555';

function jsonReq(url: string, method: string, body: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function mockDb(opts: { userExists?: boolean; partnerExists?: boolean } = { userExists: true }) {
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('UPDATE users')) {
      return Promise.resolve({
        rows: opts.userExists === false ? [] : [{ id: USER_ID, email: 'u@x.ru', name: 'Юзер', role: 'stay', preferences: {} }],
      });
    }
    if (sql.includes('SELECT id FROM partners')) {
      return Promise.resolve({ rows: opts.partnerExists ? [{ id: 'p-1' }] : [] });
    }
    if (sql.includes('SELECT name, email FROM users')) {
      return Promise.resolve({ rows: [{ name: 'Юзер', email: 'u@x.ru' }] });
    }
    if (sql.includes('INSERT INTO partners')) return Promise.resolve({ rows: [{ id: 'p-new' }] });
    if (sql.includes('INSERT INTO audit_log')) return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT id, role FROM users')) {
      return Promise.resolve({ rows: opts.userExists === false ? [] : [{ id: USER_ID, role: 'tourist' }] });
    }
    throw new Error('unexpected SQL: ' + sql);
  });
}

beforeEach(() => {
  queryMock.mockReset();
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', email: 'a@x.ru', role: 'admin' });
  mockDb();
});

describe('POST /api/roles', () => {
  it('обновляет users.role и добавляет роль в preferences.roles', async () => {
    const res = await postRole(jsonReq('http://localhost/api/roles', 'POST', { userId: USER_ID, role: 'stay' }));
    expect(res.status).toBe(200);

    const updateCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE users'))!;
    expect(String(updateCall[0])).toContain('SET role = $2');
    expect(String(updateCall[0])).toContain(`'{roles}'`);
    expect((updateCall[1] as unknown[])[0]).toBe(USER_ID);
    expect((updateCall[1] as unknown[])[1]).toBe('stay');
  });

  it('несуществующий пользователь → 404', async () => {
    mockDb({ userExists: false });

    const res = await postRole(jsonReq('http://localhost/api/roles', 'POST', { userId: USER_ID, role: 'guide' }));
    expect(res.status).toBe(404);
  });

  it('партнёрская роль → создаётся partners-профиль с user_id и category', async () => {
    const res = await postRole(jsonReq('http://localhost/api/roles', 'POST', { userId: USER_ID, role: 'gear' }));
    expect(res.status).toBe(200);

    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO partners'))!;
    expect(insertCall).toBeDefined();
    expect((insertCall[1] as unknown[])[0]).toBe(USER_ID);
    expect((insertCall[1] as unknown[])[2]).toBe('gear');
  });

  it('партнёрский профиль уже есть → второй не создаётся', async () => {
    mockDb({ userExists: true, partnerExists: true });

    const res = await postRole(jsonReq('http://localhost/api/roles', 'POST', { userId: USER_ID, role: 'gear' }));
    expect(res.status).toBe(200);

    const inserts = queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO partners'));
    expect(inserts).toHaveLength(0);
  });

  it('tourist → без партнёрского профиля', async () => {
    const res = await postRole(jsonReq('http://localhost/api/roles', 'POST', { userId: USER_ID, role: 'tourist' }));
    expect(res.status).toBe(200);

    const inserts = queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO partners'));
    expect(inserts).toHaveLength(0);
  });

  it('недопустимая роль → 400', async () => {
    const res = await postRole(jsonReq('http://localhost/api/roles', 'POST', { userId: USER_ID, role: 'superhero' }));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/admin/users/[id]', () => {
  it('принимает роль stay и создаёт партнёрский профиль', async () => {
    const res = await patchAdminUser(
      jsonReq(`http://localhost/api/admin/users/${USER_ID}`, 'PATCH', { role: 'stay' }),
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(200);

    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO partners'))!;
    expect(insertCall).toBeDefined();
    expect((insertCall[1] as unknown[])[2]).toBe('stay');
  });

  it('смена имени без роли — партнёрский профиль не трогается', async () => {
    const res = await patchAdminUser(
      jsonReq(`http://localhost/api/admin/users/${USER_ID}`, 'PATCH', { name: 'Новое имя' }),
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(200);

    const inserts = queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO partners'));
    expect(inserts).toHaveLength(0);
  });
});
