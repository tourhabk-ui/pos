/**
 * Баннер «Подключите MAX» МЕНЕДЖЕРА команды (CRM 2г-4,
 * components/operator/MemberChannelBanner.tsx).
 *
 * Что держит:
 *  - нет ни MAX, ни Telegram — баннер с двумя ссылками `om_` (их выдаёт POST);
 *  - только Telegram — честное «без имён и телефонов», ссылка только на MAX;
 *  - MAX подключён — баннера нет и ключ привязки не запрашивается вовсе;
 *  - проверка не удалась или это владелец — баннера нет: «не подключено» на
 *    сбое соврало бы (§4.0);
 *  - ссылку не выдали — сказано словами, а не пустая кнопка;
 *  - закрытая подсказка «Telegram без имён» не прячет «ничего не подключено»,
 *    а оно само скрыто только до конца сессии и не режется в одну строку.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { MemberChannelBanner } from '@/components/operator/MemberChannelBanner';

const LINKS = {
  max: 'https://max.ru/vedar_bot?start=om_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  telegram: 'https://t.me/kuzmichai_bot?start=om_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

type Reply = { ok: boolean; body: unknown };

function serve(get: Reply, post: Reply = { ok: true, body: { success: true, data: { ...LINKS, expires_at: '2026-10-14T00:00:00Z' } } }) {
  const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
    const r = init?.method === 'POST' ? post : get;
    return { ok: r.ok, json: async () => r.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const manager = (max: boolean, telegram: boolean): Reply => ({ ok: true, body: { success: true, data: { kind: 'manager', max, telegram } } });
const posts = (f: ReturnType<typeof serve>) => f.mock.calls.filter(c => c[1]?.method === 'POST').length;

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('баннер мессенджера менеджера', () => {
  it('ничего не подключено — «Подключите MAX» и обе ссылки om_', async () => {
    const f = serve(manager(false, false));
    render(<MemberChannelBanner />);
    await waitFor(() => expect(screen.getByText(/Подключите MAX — туда будут приходить новые брони/)).toBeTruthy());
    // Обещание совпадает с тем, что рассылается менеджеру (2г-4, 2г-5).
    expect(screen.getByText(/брони, заявки, запросы мест и напоминания о задачах кабинета/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('link', { name: /Подключить MAX/ }).getAttribute('href')).toBe(LINKS.max));
    expect(screen.getByRole('link', { name: /Подключить Telegram/ }).getAttribute('href')).toBe(LINKS.telegram);
    expect(screen.getByText(/Ссылка действует сутки/)).toBeTruthy();
    expect(f.mock.calls[0][0]).toBe('/api/hub/operator/me/messenger');
    expect(posts(f)).toBe(1);
  });

  it('только Telegram — «без имён и телефонов», ссылка только на MAX', async () => {
    serve(manager(false, true));
    render(<MemberChannelBanner />);
    await waitFor(() => expect(screen.getByText(/приходят вам в Telegram без имён и телефонов/)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('link', { name: /Подключить MAX/ })).toBeTruthy());
    expect(screen.queryByRole('link', { name: /Подключить Telegram/ })).toBeNull();
  });

  it('MAX подключён — баннера нет, ключ привязки не запрашивается', async () => {
    const f = serve(manager(true, false));
    const { container } = render(<MemberChannelBanner />);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(container.textContent).toBe('');
    expect(posts(f)).toBe(0);
  });

  it('проверка не удалась или это владелец — баннера нет', async () => {
    for (const get of [
      { ok: false, body: { success: false } },
      { ok: true, body: { success: true, data: { kind: 'owner' } } },
      { ok: true, body: { success: true, data: { kind: 'manager' } } },
    ]) {
      const f = serve(get);
      const { container } = render(<MemberChannelBanner />);
      await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
      await new Promise(r => setTimeout(r, 20));
      expect(container.textContent).toBe('');
      expect(posts(f)).toBe(0);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('ссылку не выдали — сказано словами, кнопок нет', async () => {
    serve(manager(false, false), { ok: false, body: { success: false } });
    render(<MemberChannelBanner />);
    await waitFor(() => expect(screen.getByText(/Ссылка для подключения сейчас не выдаётся/)).toBeTruthy());
    expect(screen.queryByRole('link', { name: /Подключить/ })).toBeNull();
  });

  it('крестик подсказки «Telegram без имён» не прячет «ничего не подключено»; оно — до конца сессии', async () => {
    serve(manager(false, true));
    const first = render(<MemberChannelBanner />);
    await waitFor(() => expect(screen.getByText(/приходят вам в Telegram без имён/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }));
    first.unmount();

    serve(manager(false, false));
    const none = render(<MemberChannelBanner />);
    const line = await screen.findByText(/Подключите MAX — туда будут приходить новые брони/);
    expect(line.className).not.toMatch(/\btruncate\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }));
    none.unmount();

    const sameSession = render(<MemberChannelBanner />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText(/Подключите MAX/)).toBeNull();
    sameSession.unmount();

    sessionStorage.clear();
    render(<MemberChannelBanner />);
    expect(await screen.findByText(/Подключите MAX — туда будут приходить новые брони/)).toBeTruthy();
  });
});
