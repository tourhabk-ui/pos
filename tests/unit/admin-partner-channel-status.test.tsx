/**
 * «Мессенджеры для заявок» в форме партнёра (02.11, «а где у них подключение
 * макс и тг?»): состояние по правилу доставки, общий чат назван, а chat id и
 * телефонов в ответе и на экране нет.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

const query = vi.fn();
const reach = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => reach(...a) }));

import { partnerChannelStatus } from '@/lib/partners/channel-status';
import ChannelLinkPanel from '@/components/admin/ChannelLinkPanel';

const ID = '11111111-1111-4111-8111-111111111111';
const CHAT = '987654321012';

beforeEach(() => { query.mockReset(); reach.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('partnerChannelStatus', () => {
  it('общий чат: да/нет, названия и чей кабинет — без chat id', async () => {
    reach.mockResolvedValue({ telegramChatId: null, maxChatId: CHAT, telegramSource: null, reachable: true });
    query.mockResolvedValue({ rows: [{ id: 'x', name: 'Лагуна Прокат', same_max: true, same_tg: false, max_first: true, tg_first: false }] });
    const s = await partnerChannelStatus(ID);
    expect(s).toEqual({ max: true, telegram: false, sharedWith: ['Лагуна Прокат'], cabinetOf: 'Лагуна Прокат' });
    expect(JSON.stringify(s)).not.toContain(CHAT);
  });

  it('партнёра нет — null; база не ответила — ошибка, а не «не подключён»', async () => {
    reach.mockResolvedValue(null);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await partnerChannelStatus(ID)).toBeNull();
    query.mockResolvedValueOnce({ rows: [{}] });
    await expect(partnerChannelStatus(ID)).rejects.toThrow();
  });
});

describe('ChannelLinkPanel в форме партнёра', () => {
  it('показывает состояние и общий чат с сервера', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { max: false, telegram: false, sharedWith: [], cabinetOf: null } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ChannelLinkPanel partnerId={ID} title="Мессенджеры для заявок" />);
    await waitFor(() => expect(screen.getByText('MAX: нет')).toBeTruthy());
    expect(screen.getByText('Telegram: нет')).toBeTruthy();
    expect(screen.getByText(/ни MAX, ни Telegram не подключены/)).toBeTruthy();
    expect(screen.getByText('Ссылка для подключения')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/operators/${ID}/channel-link`);
  });

  it('общий чат назван, кабинет — у старшей карточки', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { max: true, telegram: false, sharedWith: ['Лагуна Прокат'], cabinetOf: 'Лагуна Прокат' } }),
    }));
    render(<ChannelLinkPanel partnerId={ID} />);
    const note = await screen.findByTestId('shared-chat-note');
    expect(note.textContent).toContain('«Лагуна Прокат»');
    expect(screen.getByText('MAX: подключён')).toBeTruthy();
  });

  it('с состоянием из списка (экран «Операторы») лишнего запроса нет', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ChannelLinkPanel partnerId={ID} initialBound={{ telegram: true, max: false }} />);
    expect(screen.getByText('Telegram: подключён')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
