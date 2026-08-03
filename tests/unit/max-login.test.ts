/**
 * Вход через MAX (бот-авторизация). Зеркалит вход через Telegram, но у MAX нет
 * OAuth-виджета — подтверждение идёт через бота по одноразовому nonce. Сторож
 * фиксирует контракт безопасности: подтверждается только pending+неистёкшая
 * сессия; гашение единожды (защита от повторной выдачи JWT); бот распознаёт
 * login-payload; кнопка под фиче-флагом.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>();
vi.mock('@/lib/database', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
}));

import { authenticateMaxLoginSession, consumeMaxLoginSession, createMaxLoginSession } from '@/lib/auth/max-login';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

beforeEach(() => queryMock.mockReset());

describe('max-login: подтверждение сессии', () => {
  it('UPDATE строго pending + не истёкшую + не использованную', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const ok = await authenticateMaxLoginSession('a'.repeat(20), { maxUserId: 42, name: 'Ivan', username: null });
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('consumed = FALSE');
    expect(sql).toContain('expires_at > NOW()');
    expect(params).toEqual(['a'.repeat(20), 42, 'Ivan', null]);
  });

  it('отклоняет мусорный nonce без запроса в БД', async () => {
    const ok = await authenticateMaxLoginSession('x', { maxUserId: 1, name: null, username: null });
    expect(ok).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('нет затронутых строк → не подтверждено', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const ok = await authenticateMaxLoginSession('b'.repeat(20), { maxUserId: 7, name: null, username: null });
    expect(ok).toBe(false);
  });
});

describe('max-login: гашение единожды', () => {
  it('consume гасит только authenticated+не использованную, отдаёт данные', async () => {
    queryMock.mockResolvedValue({ rows: [{ max_user_id: '99', max_name: 'Anna', max_username: 'anna' }] });
    const res = await consumeMaxLoginSession('c'.repeat(20));
    expect(res).toEqual({ maxUserId: 99, name: 'Anna', username: 'anna' });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('SET consumed = TRUE');
    expect(sql).toContain("status = 'authenticated'");
    expect(sql).toContain('consumed = FALSE');
  });

  it('повторное гашение (нет строки) → null, JWT не выдаётся', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await consumeMaxLoginSession('c'.repeat(20))).toBeNull();
  });
});

describe('max-login: nonce секретный', () => {
  it('createMaxLoginSession пишет pending и отдаёт длинный nonce', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { nonce } = await createMaxLoginSession();
    expect(nonce.length).toBeGreaterThanOrEqual(24);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("VALUES ($1, 'pending', $2)");
  });
});

describe('max-login: интеграция', () => {
  it('бот распознаёт login-payload в bot_started', () => {
    const bot = read('app/api/max/kuzmich/route.ts');
    expect(bot).toContain("startPayload.startsWith('login-')");
    expect(bot).toContain('authenticateMaxLoginSession');
  });

  it('status-эндпоинт выдаёт JWT и куку только после consume', () => {
    const status = read('app/api/auth/max/status/route.ts');
    expect(status).toContain('consumeMaxLoginSession');
    expect(status).toContain('createToken');
    expect(status).toContain("cookies.set('auth_token'");
  });

  it('кнопка входа под фиче-флагом', () => {
    const btn = read('app/auth/login/_MaxLoginButton.tsx');
    expect(btn).toContain("NEXT_PUBLIC_MAX_LOGIN_ENABLED !== 'true'");
  });
});
