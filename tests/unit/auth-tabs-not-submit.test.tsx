/**
 * Закладки «Вход» / «Регистрация» переключают режим, а не отправляют форму.
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * У `<button>` без атрибута `type` род по умолчанию — `submit`. Обе закладки
 * входа стояли без него, то есть были кнопками отправки: пока разметка держит
 * их снаружи форм, вреда нет, но любое перемещение блока внутрь `<form>` (или
 * оборачивание страницы формой) превращает переключатель в «войти» —
 * бесшумно, потому что визуально он остаётся закладкой.
 *
 * Такой отказ дорог именно тем, что не выглядит отказом: человек жмёт
 * «Регистрация», форма уходит как вход, а экран остаётся тем же.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Правило поверх ВСЕЙ страницы входа, а не поверх двух закладок: род каждой
 * кнопки объявлен явно, кнопок отправки в каждом режиме ровно одна, и нажатие
 * закладки не вызывает submit. Сторож работает на настоящем DOM — именно DOM
 * и подставляет `submit` по умолчанию, а чтение исходника этого не видит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

const signInMock = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: signInMock, completeMfaSignIn: vi.fn() }),
  MfaRequiredError: class MfaRequiredError extends Error {
    mfaPendingToken = 'tok';
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// Внешние кнопки входа тянут чужие скрипты — для правила о роде кнопок они не
// нужны, и их собственные кнопки не должны влиять на счёт.
vi.mock('@/app/auth/login/_TelegramLoginButton', () => ({
  default: () => React.createElement('div', { 'data-testid': 'tg' }),
}));
vi.mock('@/app/auth/login/_MaxLoginButton', () => ({
  default: () => React.createElement('div', { 'data-testid': 'max' }),
}));

import AuthPageClient from '@/app/auth/login/_AuthPageClient';

function submitButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .filter((b) => b.type === 'submit');
}

beforeEach(() => {
  signInMock.mockReset();
  signInMock.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('страница входа: род кнопок объявлен, а не выведен из вёрстки', () => {
  it('закладки — не кнопки отправки', () => {
    render(<AuthPageClient />);
    for (const label of ['Вход', 'Регистрация']) {
      const tab = screen.getByRole('button', { name: label }) as HTMLButtonElement;
      expect(tab.type, `закладка «${label}» отправляет форму`).toBe('button');
    }
  });

  it('в режиме входа кнопка отправки одна', () => {
    render(<AuthPageClient />);
    const subs = submitButtons();
    expect(subs).toHaveLength(1);
    expect(subs[0].textContent).toContain('Войти');
  });

  it('в режиме регистрации кнопка отправки одна', () => {
    render(<AuthPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));
    const subs = submitButtons();
    expect(subs).toHaveLength(1);
    expect(subs[0].textContent).toContain('Зарегистрироваться');
  });

  it('нажатие закладки не выполняет вход и не отправляет форму', () => {
    render(<AuthPageClient />);
    const submitted = vi.fn();
    document.querySelectorAll('form').forEach((f) => f.addEventListener('submit', submitted));

    fireEvent.click(screen.getByRole('button', { name: 'Вход' }));
    fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));

    expect(submitted).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('нажатие активной закладки не стирает введённое', () => {
    render(<AuthPageClient />);
    const email = screen.getByPlaceholderText('your@email.com') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'turist@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Вход' }));
    expect((screen.getByPlaceholderText('your@email.com') as HTMLInputElement).value)
      .toBe('turist@example.com');
  });

  it('у каждой кнопки внутри формы род задан явно', () => {
    render(<AuthPageClient />);
    for (const form of Array.from(document.querySelectorAll('form'))) {
      for (const b of Array.from(form.querySelectorAll('button'))) {
        expect(
          b.getAttribute('type'),
          `кнопка «${b.textContent?.trim()}» внутри формы без атрибута type — по `
          + 'умолчанию это submit',
        ).not.toBeNull();
      }
    }
  });
});
