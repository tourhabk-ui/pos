/**
 * tests/unit/guide-profile-form.test.tsx
 *
 * Живая вкладка «Профиль» гида (замена мёртвой формы дашборда):
 * грузит профиль из GET /api/partners/profile в поля и сохраняет через
 * PATCH /api/partners/profile (тот же контракт, что онбординг-визард).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import GuideProfileForm from '@/app/hub/guide/_GuideProfileForm';

const PROFILE = {
  id: 'p1', name: 'Иван Гид', description: 'Опыт 10 лет',
  contact: { phone: '+7 900', telegram: '@ivan', website: '' },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { partner: PROFILE } }),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GuideProfileForm', () => {
  it('грузит профиль в поля', async () => {
    render(<GuideProfileForm />);
    await waitFor(() => expect((screen.getByLabelText(/Имя/) as HTMLInputElement).value).toBe('Иван Гид'));
    expect((screen.getByLabelText(/О себе/) as HTMLTextAreaElement).value).toBe('Опыт 10 лет');
    expect((screen.getByLabelText(/Телефон/) as HTMLInputElement).value).toBe('+7 900');
    expect((screen.getByLabelText(/Telegram/) as HTMLInputElement).value).toBe('@ivan');
  });

  it('сохраняет через PATCH и показывает подтверждение', async () => {
    render(<GuideProfileForm />);
    await waitFor(() => expect((screen.getByLabelText(/Имя/) as HTMLInputElement).value).toBe('Иван Гид'));

    fireEvent.change(screen.getByLabelText(/Имя/), { target: { value: 'Иван Камчатский' } });
    fireEvent.click(screen.getByText('Сохранить изменения'));

    await waitFor(() => expect(screen.getByText('Сохранено')).toBeTruthy());
    const patch = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(patch).toBeTruthy();
    const body = JSON.parse((patch![1] as RequestInit).body as string);
    expect(body.name).toBe('Иван Камчатский');
    expect(body.phone).toBe('+7 900');
  });

  it('пустое имя → ошибка, PATCH не уходит', async () => {
    render(<GuideProfileForm />);
    await waitFor(() => expect((screen.getByLabelText(/Имя/) as HTMLInputElement).value).toBe('Иван Гид'));
    fireEvent.change(screen.getByLabelText(/Имя/), { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Сохранить изменения'));
    await waitFor(() => expect(screen.getByText('Укажите имя')).toBeTruthy());
    const patch = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(patch).toBeUndefined();
  });
});
