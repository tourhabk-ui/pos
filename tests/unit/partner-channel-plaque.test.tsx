/**
 * Плашка привязки MAX/Telegram — крестик запоминается вместе с состоянием:
 * закрытая подсказка «Telegram без имён» не прячет «заявки до вас не дойдут»,
 * а само предупреждение скрыто только до конца сессии и не режется в строку.
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

type ChannelState = { reachable: boolean; max: boolean; telegram: boolean };

function serve(state: { value: ChannelState }, links: { ok: boolean } = { ok: true }) {
  const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      return links.ok
        ? { ok: true, json: async () => ({ success: true, data: LINKS }) }
        : { ok: false, json: async () => ({ success: false }) };
    }
    return { ok: true, json: async () => ({ success: true, data: state.value }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const TELEGRAM_ONLY: ChannelState = { reachable: true, max: false, telegram: true };
const NOTHING: ChannelState = { reachable: false, max: false, telegram: false };
const NOT_DELIVERED = /Не подключён ни MAX, ни Telegram — новые заявки и напоминания о задачах до вас не дойдут/;

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
    expect(tg.parentElement?.className).toMatch(/flex-wrap/);
    expect(close.className).toMatch(/min-h-\[44px\]/);
    expect(close.className).toMatch(/min-w-\[44px\]/);
    expect(close.parentElement?.className).not.toBe(tg.parentElement?.className);
    fireEvent.click(close);
    expect(screen.queryByRole('link', { name: /Подключить Telegram/ })).toBeNull();
    unmount();
    render(<PartnerChannelBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Подключить Telegram/ })).toBeNull();
  });

  it('закрытая подсказка «Telegram без имён» не прячет «заявки до вас не дойдут»', async () => {
    const state = { value: TELEGRAM_ONLY };
    serve(state);
    const first = render(<PartnerChannelBanner />);
    expect(await screen.findByText(/приходят в Telegram без имён и телефонов/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }));
    expect(screen.queryByText(/без имён и телефонов/)).toBeNull();
    first.unmount();

    // Подсказка скрыта и при следующем входе, пока состояние то же.
    const again = render(<PartnerChannelBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('status')).toBeNull();
    again.unmount();

    // Чат отвалился — предупреждение показывается, крестик прошлой подсказки его не глушит.
    state.value = NOTHING;
    render(<PartnerChannelBanner />);
    expect(await screen.findByText(NOT_DELIVERED)).toBeTruthy();
  });

  it('«заявки до вас не дойдут» скрыто только до конца сессии и не режется в одну строку', async () => {
    serve({ value: NOTHING });
    const first = render(<PartnerChannelBanner />);
    const line = await screen.findByText(NOT_DELIVERED);
    expect(line.textContent).toMatch(/Ссылка действует 72 часа/);
    expect(line.className).not.toMatch(/\btruncate\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }));
    first.unmount();

    const sameSession = render(<PartnerChannelBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(NOT_DELIVERED)).toBeNull();
    sameSession.unmount();

    // Новая сессия вкладки — предупреждение снова на месте.
    sessionStorage.clear();
    render(<PartnerChannelBanner />);
    expect(await screen.findByText(NOT_DELIVERED)).toBeTruthy();
  });

  it('ссылку не выдали — недоставка всё равно названа', async () => {
    serve({ value: NOTHING }, { ok: false });
    render(<PartnerChannelBanner />);
    const line = await screen.findByText(/Ссылка для подключения сейчас не выдаётся/);
    expect(line.textContent).toMatch(NOT_DELIVERED);
    expect(screen.queryByRole('link', { name: /Подключить/ })).toBeNull();
  });
});
