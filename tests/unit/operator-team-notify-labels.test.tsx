/**
 * Экран «Команда» владельца: куда менеджеру приходят копии броней и заявок
 * (CRM 2г-4). Рендером с данными сервера, а не поиском строки в файле
 * (CLAUDE.md §4, решение 13.10).
 *
 *  - у каждого ДЕЙСТВУЮЩЕГО менеджера — подпись по его подключению: MAX /
 *    Telegram без имён и телефонов / не подключено;
 *  - у ждущей ссылки подписи нет: уведомлять пока некого;
 *  - подписи без рода человека: «подключил», «в его» на Анне и Вере — неправда.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';

import TeamClient from '@/app/hub/operator/team/_TeamClient';

const member = (over: Record<string, unknown>) => ({
  status: 'active', user_email: null, can_edit_prices: false, can_cancel_bookings: false,
  created_at: '2026-10-01 00:00:00+00', invite_expires_at: null, accepted_at: '2026-10-02 00:00:00+00',
  revoked_at: null, expired: false, ...over,
});

const MEMBERS = [
  member({ id: 'm1', label: 'Вера, гиды', user_name: 'Вера Лис', max_bound: true, telegram_bound: false }),
  member({ id: 'm2', label: 'Олег, продажи', user_name: 'Олег Смирнов', max_bound: false, telegram_bound: true }),
  member({ id: 'm3', label: 'Анна, бронирования', user_name: 'Анна Петрова', max_bound: false, telegram_bound: false }),
  member({ id: 'm4', status: 'invited', label: 'Новый гид', user_name: null, accepted_at: null, invite_expires_at: '2099-01-01 00:00:00+00' }),
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«Команда»: куда менеджеру приходят уведомления', () => {
  it('подпись у каждого действующего менеджера по его подключению; у ждущей ссылки — нет', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { members: MEMBERS } }) })));
    render(<TeamClient />);
    const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement;

    expect(within(await row('Вера Лис')).getByText('Уведомления: в MAX')).toBeTruthy();
    expect(within(await row('Олег Смирнов')).getByText('Уведомления: в Telegram, без имён и телефонов — MAX не подключён')).toBeTruthy();
    expect(within(await row('Анна Петрова')).getByText(/Уведомления не подключены/)).toBeTruthy();
    expect(within(await row('Новый гид')).queryByText(/Уведомления/)).toBeNull();

    const page = document.body.textContent ?? '';
    expect(page).toMatch(/брони, заявки, запросы мест и напоминания о задачах приходят и менеджерам/);
    expect(page).not.toMatch(/в его (MAX|Telegram)|подключил /);
  });

  it('старый ответ сервера без полей подключения — «не подключены», а не «в MAX»', async () => {
    const legacy = MEMBERS.slice(0, 1).map(({ max_bound: _m, telegram_bound: _t, ...rest }) => rest);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { members: legacy } }) })));
    render(<TeamClient />);
    const li = (await screen.findByText('Вера Лис')).closest('li') as HTMLElement;
    expect(within(li).getByText(/Уведомления не подключены/)).toBeTruthy();
  });
});
