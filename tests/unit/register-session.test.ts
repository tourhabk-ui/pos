// @vitest-environment node
// (jose подписывает JWT через WebCrypto — в jsdom его нет)
/**
 * Регистрация выдаёт ЖИВУЮ сессию (аудит кабинета оператора, пакет «Г», п.1).
 *
 * `getUserFromRequest` пропускает токен, только если его строка есть в
 * `user_sessions` (lib/auth/jwt.ts, isSessionActive). Регистрация выдавала
 * токен и cookie, а строку не писала — только что созданный аккаунт получал
 * 401 на всё до повторного входа. Задевало все роли.
 *
 * Сторож держит связку целиком: строка пишется, в ней ТОТ ЖЕ токен, что
 * уходит в cookie и в тело ответа; запись идёт до COMMIT (в транзакции) и
 * общей с входом функцией, а не своей копией.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
vi.mock('@/lib/auth/password', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/password')>()),
  hashPassword: vi.fn().mockResolvedValue('$hashed$'),
}));

process.env.JWT_SECRET = 'test-secret-for-register-session';

import { POST } from '@/app/api/auth/register/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function registerReq(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pd_consent: true, ...body }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  clientQueryMock.mockReset();
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT id FROM users WHERE email')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO users')) {
      return Promise.resolve({
        rows: [{ id: 'user-uuid-12345678', email: 'op@x.ru', name: 'Оператор', role: 'operator', preferences: {} }],
      });
    }
    if (sql.includes('INSERT INTO partners')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO user_sessions')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + sql);
  });
});

function calls(fragment: string) {
  return clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

describe('регистрация пишет user_sessions', () => {
  it('строка сессии несёт тот же токен, что уходит в cookie и в ответ', async () => {
    const res = await POST(registerReq({
      email: 'op@x.ru', password: 'Secret123', name: 'Оператор', role: 'operator',
    }));
    expect(res.status).toBe(201);

    const body = await res.json() as { token: string };
    const cookie = res.headers.get('set-cookie') ?? '';
    const cookieToken = /auth_token=([^;]+)/.exec(cookie)?.[1];

    const sessions = calls('INSERT INTO user_sessions');
    expect(sessions, 'регистрация не записала сессию — токен мёртв до повторного входа').toHaveLength(1);
    const [, params] = sessions[0] as [string, unknown[]];
    expect(params[0]).toBe('user-uuid-12345678');
    expect(params[1]).toBe(body.token);
    expect(params[1]).toBe(cookieToken);
    // Срок сессии — неделя, как у JWT.
    const ttlMs = (params[2] as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(ttlMs).toBeLessThan(7.1 * 24 * 3600 * 1000);
  });

  it('сессия пишется ДО COMMIT — в той же транзакции, что и аккаунт', async () => {
    await POST(registerReq({
      email: 't@x.ru', password: 'Secret123', name: 'Турист', role: 'tourist',
    }));
    const order = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    const iSession = order.findIndex((s) => s.includes('INSERT INTO user_sessions'));
    const iCommit = order.indexOf('COMMIT');
    expect(iSession).toBeGreaterThan(-1);
    expect(iSession).toBeLessThan(iCommit);
  });

  it('не записалась сессия — токена нет, транзакция откатывается', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO user_sessions')) {
        return Promise.reject(Object.assign(new Error('boom'), { code: '42P01' }));
      }
      if (sql.includes('SELECT id FROM users WHERE email')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 'u1', email: 'a@x.ru', name: 'A', role: 'tourist', preferences: {} }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await POST(registerReq({ email: 'a@x.ru', password: 'Secret123', name: 'A' }));
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('auth_token=');
    const order = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(order).toContain('ROLLBACK');
    expect(order).not.toContain('COMMIT');
  });
});

describe('одна форма записи сессии на вход и регистрацию', () => {
  it('регистрация и вход зовут recordUserSession, своего INSERT у них нет', () => {
    for (const f of ['app/api/auth/register/route.ts', 'app/api/auth/signin/route.ts']) {
      const src = read(f);
      expect(src, `${f}: сессия пишется не общей функцией`).toMatch(/recordUserSession\(/);
      expect(src, `${f}: своя копия INSERT INTO user_sessions`).not.toMatch(/INSERT INTO user_sessions/);
    }
  });

  it('срок сессии совпадает со сроком JWT', () => {
    expect(read('lib/auth/session-record.ts')).toMatch(/SESSION_TTL_DAYS = 7\b/);
    expect(read('lib/auth/jwt.ts')).toMatch(/JWT_EXPIRATION = '7d'/);
  });
});

describe('контакты с формы партнёра доходят до профиля (п.5)', () => {
  it('телефон и Telegram оператора пишутся в partners.contacts', async () => {
    await POST(registerReq({
      email: 'op2@x.ru', password: 'Secret123', name: 'Оператор', role: 'operator',
      phone: ' +7 900 000-00-00 ', telegram: '@kamop',
    }));
    const [sql, params] = calls('INSERT INTO partners')[0] as [string, unknown[]];
    expect(sql).toMatch(/contacts/);
    const contacts = JSON.parse(String(params[3])) as Record<string, string>;
    expect(contacts).toEqual({ phone: '+7 900 000-00-00', telegram: '@kamop' });
  });

  it('пустые поля не пишутся пустыми строками', async () => {
    await POST(registerReq({
      email: 'op3@x.ru', password: 'Secret123', name: 'Оператор', role: 'operator',
      phone: '', telegram: '  ',
    }));
    const [, params] = calls('INSERT INTO partners')[0] as [string, unknown[]];
    expect(JSON.parse(String(params[3]))).toEqual({});
  });
});
