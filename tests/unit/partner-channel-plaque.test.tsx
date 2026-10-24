/**
 * Плашка привязки MAX/Telegram — одна строка, крестик запоминается.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';

const LINKS = {
  max: 'https://max.ru/bot?start=op_x',
  telegram: 'https://t.me/kuzmichai_bot?start=op_x',
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('плашка канала партнёра', () => {
  it('крестик и «Подключить Telegram» не ниже 44px, скрытие переживает новый монтаж', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ success: true, data: LINKS }) };
      }
      return {
        ok: true,
        json: async () => ({ success: true, data: { reachable: false, max: false, telegram: false } }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<PartnerChannelBanner />);
    const tg = await screen.findByRole('link', { name: /Подключить Telegram/ });
    const close = screen.getByRole('button', { name: 'Скрыть подсказку' });
    expect(tg.className).toMatch(/min-h-\[44px\]/);
    expect(close.className).toMatch(/min-h-\[44px\]/);
    expect(close.className).toMatch(/min-w-\[44px\]/);
    fireEvent.click(close);
    expect(screen.queryByRole('link', { name: /Подключить Telegram/ })).toBeNull();
    unmount();
    render(<PartnerChannelBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Подключить Telegram/ })).toBeNull();
  });
});
