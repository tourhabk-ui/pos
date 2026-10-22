/**
 * Экран удаления аккаунта показывает человеку ответ сервера — что стёрто и
 * что осталось (#2327). Прежде экран сразу уводил на главную, и ответ, даже
 * честный, никто бы не прочитал: объявленный исход без потребителя (§10.09).
 * Рендером: после удаления на экране текст сервера, кнопки удаления нет.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import DeleteAccount from '@/app/hub/tourist/profile/_DeleteAccount';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

async function confirmDelete() {
  fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }));
  fireEvent.change(screen.getByLabelText('Слово для подтверждения'), { target: { value: 'удалить' } });
  fireEvent.click(screen.getByRole('button', { name: 'Удалить навсегда' }));
}

describe('экран удаления аккаунта: ответ сервера виден человеку', () => {
  it('осталось у человека — экран называет это словами сервера', async () => {
    const message = 'Аккаунт удалён: документы и привязки Telegram и MAX стёрты, имя, телефон и почта — везде, кроме названного ниже. '
      + 'Осталось: карточка партнёра, скрытая с витрины — на неё ссылаются туры и брони.';
    const calls = stubFetch(200, { success: true, message });
    render(<DeleteAccount />);
    await confirmDelete();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message));
    expect(calls).toEqual([{ url: '/api/user/delete', body: { confirm: true, phrase: 'удалить', mode: 'delete' } }]);
    expect(screen.queryByRole('button', { name: 'Удалить навсегда' })).toBeNull();
    expect(screen.getByRole('button', { name: 'На главную' })).toBeTruthy();
  });

  it('отказ сервера — ошибка, а не «удалён»', async () => {
    stubFetch(409, { success: false, error: 'У вас есть предстоящая заявка на тур.' });
    render(<DeleteAccount />);
    await confirmDelete();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('У вас есть предстоящая заявка на тур.'));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
