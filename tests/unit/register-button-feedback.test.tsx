/**
 * «Зарегистрироваться» всегда отвечает. Повод 20.10: с телефона пароль из
 * 6 символов уходил на сервер (правило — 8, заглавная, цифра), ответ 400
 * рисовался плашкой вверху формы за краем экрана, а каждая попытка жгла лимит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: vi.fn(), completeMfaSignIn: vi.fn() }),
  MfaRequiredError: class extends Error {},
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('@/app/auth/login/_TelegramLoginButton', () => ({ default: () => null }));
vi.mock('@/app/auth/login/_MaxLoginButton', () => ({ default: () => null }));

import AuthPageClient from '@/app/auth/login/_AuthPageClient';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fill(pw: string, consent = true) {
  render(<AuthPageClient />);
  fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));
  fireEvent.change(document.getElementById('reg-name') ?? screen.getByPlaceholderText(/имя/i), { target: { value: 'Тест' } });
  fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'flo+t@vedarai.ru' } });
  fireEvent.change(document.getElementById('reg-password')!, { target: { value: pw } });
  fireEvent.change(document.getElementById('reg-password-confirm')!, { target: { value: pw } });
  if (consent) fireEvent.click(screen.getByRole('checkbox'));
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));

describe('кнопка регистрации', () => {
  it('правило пароля видно сразу', () => {
    render(<AuthPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));
    expect(document.getElementById('reg-password-hint')?.textContent).toMatch(/Минимум 8 символов/);
  });

  it('6 символов: ошибка у поля и у кнопки, фокус на пароле, сервер не дёргаем', () => {
    fill('abc123');
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById('reg-password-hint')?.textContent).toMatch(/минимум 8 символов/);
    expect(screen.getByTestId('register-error')).toBeTruthy();
    expect(document.activeElement?.id).toBe('reg-password');
  });

  it('без галочки кнопка не мёртвая — объясняет', () => {
    fill('Vulkan2026x', false);
    const btn = screen.getByRole('button', { name: 'Зарегистрироваться' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    submit();
    expect(screen.getByTestId('register-error').textContent).toMatch(/согласие/);
  });

  it('ошибка API (429, не-JSON) видна у кнопки', async () => {
    fill('Vulkan2026x');
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error('html')) });
    submit();
    await waitFor(() => expect(screen.getByTestId('register-error').textContent).toMatch(/502/));
  });

  it('успех — переход в кабинет', async () => {
    fill('Vulkan2026x');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true, user: { id: '1' }, token: 't' }) });
    submit();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/hub/tourist'));
    expect(push).not.toHaveBeenCalled();
  });
});
