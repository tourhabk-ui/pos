/**
 * tests/unit/auth-context-cookie-fallback.test.tsx
 *
 * AuthContext — auth-БАГ: user инициализировался ТОЛЬКО из localStorage['user'],
 * а magic-link вход (ссылка из Telegram-бота) ставит лишь httpOnly-cookie —
 * такой юзер был невидим для всех потребителей useAuth (Protected выкидывал
 * залогиненного на /auth/login). Контракт: localStorage пуст → fallback-фетч
 * /api/auth/me БЕЗ Authorization (cookie); 401/ошибка → гость без вечного
 * loading; валидный localStorage → прежний Bearer-путь.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function Probe() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <div>{user ? `user:${user.name}:${user.roles.join(',')}` : 'guest'}</div>;
}

const ME_RESPONSE = {
  success: true,
  data: {
    id: 'u-1',
    email: 'ivan@example.com',
    name: 'Иван',
    role: 'tourist',
    roles: ['tourist'],
    preferences: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('AuthContext — cookie-only сессии (magic-link)', () => {
  it('localStorage пуст + cookie-сессия жива → user заполнен, user_roles записан', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ME_RESPONSE),
    });

    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('user:Иван:tourist')).toBeInTheDocument();
    });

    // Запрос ушёл БЕЗ Authorization — сервер читает httpOnly-cookie
    const meCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/auth/me'));
    expect(meCall).toBeTruthy();
    expect(meCall![1]).toBeUndefined();

    // Паритет с signIn: AdminProtected читает user_roles
    expect(JSON.parse(localStorage.getItem('user_roles')!)).toEqual(['tourist']);
    // cookie-only юзер НЕ пишется в localStorage['user'] (нет токена)
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('localStorage пуст + 401 → гость, без вечного loading', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({ success: false }) });

    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('guest')).toBeInTheDocument();
    });
  });

  it('localStorage пуст + сеть упала → гость, ошибка не всплывает', async () => {
    fetchMock.mockRejectedValue(new Error('network'));

    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('guest')).toBeInTheDocument();
    });
  });

  it('валидный localStorage → прежний Bearer-путь, cookie-fallback не дёргается', async () => {
    localStorage.setItem('user', JSON.stringify({
      ...ME_RESPONSE.data,
      token: 'jwt-token',
    }));
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ME_RESPONSE),
    });

    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('user:Иван:tourist')).toBeInTheDocument();
    });

    // Ровно один запрос /api/auth/me — с Bearer, второго (cookie) нет
    const meCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/auth/me'));
    expect(meCalls).toHaveLength(1);
    expect((meCalls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer jwt-token');
  });

  it('localStorage протух (Bearer 401), но cookie жива → user восстановлен через fallback', async () => {
    localStorage.setItem('user', JSON.stringify({
      ...ME_RESPONSE.data,
      token: 'expired-token',
    }));
    fetchMock.mockImplementation((_url: string, init?: { headers?: Record<string, string> }) => {
      if (init?.headers?.Authorization) {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(ME_RESPONSE) });
    });

    render(<AuthProvider><Probe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('user:Иван:tourist')).toBeInTheDocument();
    });
    // Протухший localStorage вычищен
    expect(localStorage.getItem('user')).toBeNull();
  });
});
