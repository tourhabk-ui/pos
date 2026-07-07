// @vitest-environment node
// (jose подписывает JWT через WebCrypto — в jsdom его нет)
/**
 * tests/unit/register-by-role.test.ts
 *
 * Регистрация по типу пользователя (POST /api/auth/register):
 * - партнёрские роли (stay/gear/guide/...) получают запись в partners
 *   с category=роль и user_id — иначе их кабинеты не видят данных;
 * - мультироли: по партнёрскому профилю на каждую роль;
 * - tourist партнёрского профиля не получает;
 * - operator сохраняет расширенную вставку (commission_rate, slug);
 * - в JWT-ответе есть role и roles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  pool: {
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => clientQueryMock(...args),
      release: () => undefined,
    }),
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
}));

vi.mock('@/lib/auth/password', () => ({
  hashPassword: vi.fn().mockResolvedValue('$hashed$'),
}));

process.env.JWT_SECRET = 'test-secret-for-register-by-role';

import { POST } from '@/app/api/auth/register/route';

function registerReq(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pd_consent: true, ...body }),
  }) as unknown as NextRequest;
}

function mockDb() {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT id FROM users WHERE email')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO users')) {
      return Promise.resolve({
        rows: [{ id: 'user-uuid-12345678', email: 'p@x.ru', name: 'Партнёр', role: 'stay', preferences: {} }],
      });
    }
    if (sql.includes('INSERT INTO partners')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + sql);
  });
}

function partnerInsertCalls() {
  return clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO partners'));
}

beforeEach(() => {
  clientQueryMock.mockReset();
  mockDb();
});

describe('POST /api/auth/register — партнёрские профили по ролям', () => {
  it('stay: создаётся partners-запись с category=stay и user_id', async () => {
    const res = await POST(registerReq({
      email: 'stay@x.ru', password: 'secret1', name: 'Гостиница',
      role: 'stay', roles: ['stay'],
    }));
    expect(res.status).toBe(201);

    const inserts = partnerInsertCalls();
    expect(inserts).toHaveLength(1);
    const [, params] = inserts[0];
    expect((params as unknown[])[0]).toBe('user-uuid-12345678'); // user_id
    expect((params as unknown[])[2]).toBe('stay');               // category
  });

  it('мультироли gear+transfer: по профилю на каждую роль', async () => {
    const res = await POST(registerReq({
      email: 'multi@x.ru', password: 'secret1', name: 'Партнёр',
      roles: ['gear', 'transfer'],
    }));
    expect(res.status).toBe(201);

    const categories = partnerInsertCalls().map(([, params]) => (params as unknown[])[2]);
    expect(categories).toEqual(['gear', 'transfer']);
  });

  it('tourist: партнёрский профиль не создаётся', async () => {
    const res = await POST(registerReq({
      email: 't@x.ru', password: 'secret1', name: 'Турист', role: 'tourist',
    }));
    expect(res.status).toBe(201);
    expect(partnerInsertCalls()).toHaveLength(0);
  });

  it('operator: сохраняется расширенная вставка с commission_rate и slug', async () => {
    const res = await POST(registerReq({
      email: 'op@x.ru', password: 'secret1', name: 'Оператор', role: 'operator',
    }));
    expect(res.status).toBe(201);

    const inserts = partnerInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0][0])).toContain('commission_rate');
    expect(String(inserts[0][0])).toContain('slug');
  });

  it('ответ содержит role и roles, токен уходит в cookie', async () => {
    const res = await POST(registerReq({
      email: 'stay2@x.ru', password: 'secret1', name: 'Гостиница',
      roles: ['stay', 'gear'],
    }));
    expect(res.status).toBe(201);

    const body = await res.json() as { user: { role: string; roles: string[] }; token: string };
    expect(body.user.roles).toEqual(['stay', 'gear']);
    expect(body.token).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
  });
});
