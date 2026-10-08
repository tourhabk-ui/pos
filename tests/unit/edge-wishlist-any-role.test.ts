// @vitest-environment node
/**
 * Избранное на Edge: любая вошедшая роль, остальной /api/tourist — за ролью
 * (слово владельца 09.10, §7).
 *
 * Скрин владельца с телефона: сердечко на карточке тура — «Не удалось
 * сохранить». Ответ был 403: `/api/tourist` стоит под правилом «только
 * tourist», а сердечко нажимается у оператора, гида, агента и администратора.
 * Решение владельца: избранное работает под любой ролью.
 *
 * Тест ИСПОЛНЯЕТ middleware настоящими запросами (как edge-admin-gate):
 * строка «исключение есть» в тексте ничего не доказывает, пока до неё не
 * дошла очередь. Ответ «пропущен» — NextResponse.next(), заголовок
 * x-middleware-next: 1.
 *
 * Исключение держится узким: ровно один адрес, токен обязателен, остальные
 * адреса туриста по-прежнему отвечают 403 любой другой роли.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { createToken } from '@/lib/auth/jwt';

const JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
const ROLES = ['tourist', 'operator', 'guide', 'agent', 'stay', 'gear', 'transfer_operator', 'admin'] as const;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

async function run(path: string, role: string | null, method = 'GET') {
  const { middleware } = await import('../../middleware');
  const headers: Record<string, string> = {};
  if (role) {
    const token = await createToken({ userId: 'u1', email: `${role}@vedarai.ru`, role });
    headers.cookie = `auth_token=${token}`;
  }
  return middleware(new NextRequest(`https://vedarai.ru${path}`, { method, headers }));
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('избранное — любая вошедшая роль', () => {
  for (const role of ROLES) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      it(`${role}: ${method} /api/tourist/wishlist пропущен на Edge`, async () => {
        const res = await run('/api/tourist/wishlist', role, method);
        expect(res.status, `${role} ${method}`).not.toBe(403);
        expect(passed(res)).toBe(true);
      });
    }
  }

  it('удаление по id (?id=) тоже пропущено', async () => {
    expect(passed(await run('/api/tourist/wishlist?id=abc', 'operator', 'DELETE'))).toBe(true);
  });
});

describe('исключение узкое', () => {
  it('гость без токена — по-прежнему 401: вход обязателен', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await run('/api/tourist/wishlist', null, method);
      expect(passed(res), method).toBe(false);
      expect(res.status, method).toBe(401);
    }
  });

  it('остальной /api/tourist — только tourist: оператору 403, туристу пропуск', async () => {
    for (const path of ['/api/tourist/profile', '/api/tourist/documents', '/api/tourist/notification-preferences']) {
      const denied = await run(path, 'operator');
      expect(denied.status, `${path} оператору`).toBe(403);
      expect(passed(denied)).toBe(false);
      expect(passed(await run(path, 'tourist')), `${path} туристу`).toBe(true);
    }
  });

  it('адрес-двойник не попадает под исключение: сверка по сегментам, не по началу строки', async () => {
    const res = await run('/api/tourist/wishlist-export', 'operator');
    expect(res.status).toBe(403);
  });

  it('в списке исключений ровно один адрес', () => {
    const src = readFileSync('middleware.ts', 'utf8');
    const m = src.match(/const API_ANY_ROLE_PATHS = \[([^\]]*)\]/);
    expect(m, 'список исключений не найден').not.toBeNull();
    expect((m![1].match(/'[^']+'/g) ?? [])).toEqual(["'/api/tourist/wishlist'"]);
  });
});
