// @vitest-environment node
/**
 * /api/operator/* на Edge: оператор и администратор (слово владельца 15.11
 * «Разрешить админу», четвёртое исключение §7).
 *
 * Скрин владельца: «Обзор оператора» — «Ошибка загрузки. Forbidden».
 * Страница кабинета пускает администратора, роуты сами — тоже
 * (requireOperator), а вход сайта для /api/operator/* требовал ровно роль
 * operator. Тест ИСПОЛНЯЕТ middleware настоящими запросами, как
 * edge-wishlist-any-role: «пропущен» — заголовок x-middleware-next: 1.
 *
 * Исключение узкое: другие роли на /api/operator/* — 403, администратор на
 * чужих ролевых адресах (/api/tourist, /api/guide) — 403, гость — 401.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth/jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

async function run(path: string, role: string | null) {
  const { middleware } = await import('../../middleware');
  const headers: Record<string, string> = {};
  if (role) {
    const token = await createToken({ userId: 'u1', email: `${role}@vedarai.ru`, role });
    headers.cookie = `auth_token=${token}`;
  }
  return middleware(new NextRequest(`https://vedarai.ru${path}`, { headers }));
}
const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

const OPERATOR_API = ['/api/operator/dashboard?period=30', '/api/operator/tours', '/api/operator/bookings', '/api/operator/stats'];

describe('/api/operator/* — оператор и администратор', () => {
  for (const path of OPERATOR_API) {
    it(`${path}: оператор и администратор пропущены`, async () => {
      expect(passed(await run(path, 'operator'))).toBe(true);
      const admin = await run(path, 'admin');
      expect(admin.status).not.toBe(403);
      expect(passed(admin)).toBe(true);
    });
  }
});

describe('исключение узкое', () => {
  it('другие роли на /api/operator/* — 403', async () => {
    for (const role of ['tourist', 'guide', 'agent', 'stay', 'gear', 'transfer_operator']) {
      const res = await run('/api/operator/dashboard', role);
      expect(res.status, role).toBe(403);
      expect(passed(res), role).toBe(false);
    }
  });

  it('гость — 401', async () => {
    expect((await run('/api/operator/dashboard', null)).status).toBe(401);
  });

  it('администратор на чужих ролевых адресах — по-прежнему 403', async () => {
    for (const path of ['/api/tourist/profile', '/api/guide/tours']) {
      expect((await run(path, 'admin')).status, path).toBe(403);
    }
  });
});
