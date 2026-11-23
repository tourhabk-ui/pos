// @vitest-environment jsdom
/**
 * Роль партнёра из ссылки на регистрацию (план готовности 23.11, этап 3a).
 *
 * Страница роли ведёт на `/auth/login?mode=register&role=<роль>`: форма
 * открывается в режиме регистрации, «Партнёр» и направление уже отмечены.
 * Роль из адреса — подсказка, а не право: список закрыт, чужое значение не
 * выбирает ничего; проверяет роль сервер. Судится рендером формы.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: vi.fn(), completeMfaSignIn: vi.fn() }),
  MfaRequiredError: class extends Error {},
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/app/auth/login/_TelegramLoginButton', () => ({ default: () => null }));
vi.mock('@/app/auth/login/_MaxLoginButton', () => ({ default: () => null }));

import AuthPageClient from '@/app/auth/login/_AuthPageClient';
import { REGISTER_LINK_ROLES, partnerRegisterPath, registerRoleFromSearch } from '@/lib/auth/register-link';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const open = (url: string) => {
  window.history.replaceState(null, '', url);
  render(<AuthPageClient />);
};
/** Нажатые кнопки формы — по подписи, как их слышит читалка. */
const pressed = () => screen.queryAllByRole('button', { pressed: true }).map((b) => b.textContent ?? '');
const LABEL: Record<string, string> = {
  operator: 'Туроператор', guide: 'Гид', transfer: 'Трансфер', stay: 'Владелец жилья', gear: 'Прокат снаряжения',
  cars: 'Прокат автомобилей',
};

describe('registerRoleFromSearch', () => {
  it('роль берётся только из закрытого списка и только при mode=register', () => {
    for (const role of REGISTER_LINK_ROLES) {
      expect(registerRoleFromSearch(`?mode=register&role=${role}`)).toBe(role);
      expect(registerRoleFromSearch(new URL(partnerRegisterPath(role), 'http://x').search)).toBe(role);
    }
    for (const bad of ['?role=stay', '?mode=login&role=stay', '?mode=register', '?mode=register&role=admin',
      '?mode=register&role=agent', '?mode=register&role=tourist', '?mode=register&role=STAY', '?mode=register&role=', '']) {
      expect(registerRoleFromSearch(bad), bad).toBeNull();
    }
  });

  it('агента в списке нет: роль заморожена', () => {
    expect(REGISTER_LINK_ROLES).not.toContain('agent');
    expect(REGISTER_LINK_ROLES).not.toContain('admin');
  });
});

describe('форма входа читает роль из ссылки', () => {
  it.each(REGISTER_LINK_ROLES.map((r) => [r]))('?mode=register&role=%s: «Партнёр» и направление отмечены', async (role) => {
    open(partnerRegisterPath(role));
    await waitFor(() => expect(pressed().some((t) => t.includes('Партнёр'))).toBe(true));
    const on = pressed();
    expect(on.some((t) => t.includes(LABEL[role]))).toBe(true);
    // Отмечено одно направление — не все.
    expect(on).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Зарегистрироваться' })).toBeTruthy();
  });

  it('чужая роль в адресе ничего не выбирает: регистрация туриста, как прежде', async () => {
    for (const bad of ['admin', 'agent', 'мусор']) {
      open(`/auth/login?mode=register&role=${encodeURIComponent(bad)}`);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Зарегистрироваться' })).toBeTruthy());
      const on = pressed();
      expect(on.some((t) => t.includes('Путешественник')), bad).toBe(true);
      expect(on.some((t) => t.includes('Партнёр')), bad).toBe(false);
      cleanup();
    }
  });

  it('без mode=register роль не читается: открывается вход', async () => {
    open('/auth/login?role=stay');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Зарегистрироваться' })).toBeNull());
  });

  it('отправка несёт выбранную роль в общую дверь регистрации', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ success: false, error: 'стоп' }) });
    open(partnerRegisterPath('stay'));
    await waitFor(() => expect(pressed().some((t) => t.includes('Владелец жилья'))).toBe(true));
    fireEvent.change(document.getElementById('reg-name')!, { target: { value: 'Тест' } });
    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'test@example.com' } });
    fireEvent.change(document.getElementById('reg-password')!, { target: { value: 'Vulkan2026x' } });
    fireEvent.change(document.getElementById('reg-password-confirm')!, { target: { value: 'Vulkan2026x' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/auth/register');
    const body = JSON.parse(init.body) as { role: string; roles: string[] };
    expect(body.role).toBe('stay');
    expect(body.roles).toEqual(['stay']);
  });
});
