/**
 * Перебор пароля не снимается сменой X-Forwarded-For (P3-02 аудита 15.10).
 *
 * Лимит входа по адресу берёт ключ из `getClientIp` — первого элемента
 * X-Forwarded-For, который пишет сам клиент. Скрипт, меняющий заголовок с
 * каждым запросом, проходил лимит «5 в минуту» сколько угодно раз. Второй
 * тормоз — по почте: её перебор подменить не может, он обязан назвать
 * именно ту учётную запись, которую ломает.
 *
 * Сторож — вызов роута: одна почта, каждый раз новый XFF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-signin-email-limit';

import { POST } from '@/app/api/auth/signin/route';

let hop = 0;
/** Каждый запрос — с новым «клиентским» адресом, как у скрипта перебора. */
function signin(email: string, password = 'wrong-password'): Promise<Response> {
  hop += 1;
  return POST(new Request('http://localhost/api/auth/signin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `203.0.113.${hop % 250}, 10.0.0.1`,
    },
    body: JSON.stringify({ email, password }),
  }) as unknown as NextRequest);
}

function usersLookups(): number {
  return queryMock.mock.calls.filter(([sql]) => String(sql).includes('FROM users')).length;
}

beforeEach(() => {
  queryMock.mockReset();
  // Почты нет в базе — каждая попытка честно получает 401.
  queryMock.mockResolvedValue({ rows: [] });
});

describe('лимит входа по почте', () => {
  it('десять попыток с разными XFF проходят до базы, одиннадцатая — 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await signin('victim@example.ru');
      expect(res.status, `попытка ${i + 1}`).toBe(401);
    }
    expect(usersLookups()).toBe(10);

    // Регистр почты ключ не меняет — в базе она ищется в нижнем.
    const blocked = await signin('Victim@Example.RU');
    expect(blocked.status).toBe(429);
    const body = await blocked.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Слишком много попыток входа/);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Заблокированная попытка до проверки пароля не доходит.
    expect(usersLookups()).toBe(10);
  });

  it('лимит — на почту, а не общий: другая учётная запись входит', async () => {
    for (let i = 0; i < 11; i += 1) await signin('target@example.ru');
    const other = await signin('someone-else@example.ru');
    expect(other.status).toBe(401);
  });
});
