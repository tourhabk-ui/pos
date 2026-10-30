/**
 * Статус входа через MAX: истечение судит база, а не часы приложения.
 *
 * Случай 30.10 (kernel-pg на main f0408ac): «Нет, не я» гасит сессию записью
 * `expires_at = NOW()` часами PostgreSQL, а статус читал её часами Node с
 * усечением микросекунд (`new Date(text).getTime() < Date.now()`) — в той же
 * миллисекунде сессия отвечала «pending», и браузер, начавший вход, не получал
 * «истекла». Теперь строка несёт `expired` из базы (`expires_at <= NOW()`), и
 * роут судит по нему.
 *
 * Сторож — вызовом роута с подложенной сессией:
 *  - база говорит «истекла», хотя по часам Node срок ещё впереди → expired;
 *  - база говорит «не истекла», хотя по часам Node срок позади → pending
 *    (часы приложения больше не участвуют);
 *  - чтение сессии просит базу назвать истечение сама (`expires_at <= NOW()`),
 *    и значение из строки доходит до вызывающего без пересчёта.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const sessionMock = vi.fn();
vi.mock('@/lib/auth/max-login', () => ({
  getMaxLoginSession: (nonce: string) => sessionMock(nonce),
  consumeMaxLoginSession: vi.fn(),
}));
vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/auth/jwt', () => ({ createToken: vi.fn() }));

const NONCE = 'n'.repeat(24);
const req = () => new NextRequest(`https://vedarai.ru/api/auth/max/status?nonce=${NONCE}`);

beforeEach(() => sessionMock.mockReset());

describe('статус входа через MAX судит истечение часами базы', () => {
  it('база: истекла, Node: срок ещё впереди → expired', async () => {
    sessionMock.mockResolvedValue({
      status: 'pending', max_user_id: '710001', max_name: 'Анна', max_username: null, consumed: false,
      expires_at: new Date(Date.now() + 60_000).toISOString(), expired: true,
    });
    const { GET } = await import('@/app/api/auth/max/status/route');
    const body = await (await GET(req())).json();
    expect(body.status).toBe('expired');
  });

  it('база: не истекла, Node: срок позади → pending (часы приложения не участвуют)', async () => {
    sessionMock.mockResolvedValue({
      status: 'pending', max_user_id: null, max_name: null, max_username: null, consumed: false,
      expires_at: new Date(Date.now() - 60_000).toISOString(), expired: false,
    });
    const { GET } = await import('@/app/api/auth/max/status/route');
    const body = await (await GET(req())).json();
    expect(body.status).toBe('pending');
  });
});

describe('getMaxLoginSession просит истечение у базы', () => {
  it('SQL сравнивает expires_at с NOW() базы, значение строки доходит как есть', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/auth/max-login');
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ status: 'pending', max_user_id: null, max_name: null, max_username: null, consumed: false, expires_at: 'x', expired: true }],
    });
    vi.doMock('@/lib/database', () => ({ query: (sql: string, params?: unknown[]) => queryMock(sql, params) }));
    const { getMaxLoginSession } = await import('@/lib/auth/max-login');
    const s = await getMaxLoginSession(NONCE);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/expires_at\s*<=\s*NOW\(\)\)\s+AS\s+expired/);
    expect(params).toEqual([NONCE]);
    expect(s?.expired).toBe(true);
  });
});
