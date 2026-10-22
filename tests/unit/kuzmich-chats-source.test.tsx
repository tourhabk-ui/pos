// @vitest-environment jsdom
/**
 * «Переписки» Кузьмича в админке: у каждого разговора виден вход, и ответы
 * суток разложены по входам — рендером (вопрос владельца 22.10: «кузьмич
 * вчера 3 ответа а в переписках нету кто откуда»).
 *
 * До правки список знал только Telegram/MAX и сайт: разговоры агентов A2A
 * (a2a_dialogs) в нём не было вовсе, виджет партнёра и проверки безопасности
 * Кузьмича выглядели как «Гость», а число ответов на обзоре было не с чем
 * сверить. SQL списка — tests/integration/admin-day-counts.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const CHATS = {
  tgChats: [
    { chatId: '171', platform: 'telegram', userName: 'Иван', userMsgs: 1, totalMsgs: 2, firstMsg: '2026-10-21T09:00:00Z', lastMsg: '2026-10-21T09:00:00Z', partnerChat: false },
    { chatId: '501', platform: 'telegram', userName: 'Оператор', userMsgs: 3, totalMsgs: 6, firstMsg: '2026-10-18T09:00:00Z', lastMsg: '2026-10-18T09:00:00Z', partnerChat: true },
    { chatId: '502', platform: 'whatsapp', userName: 'Гость WA', userMsgs: 1, totalMsgs: 2, firstMsg: '2026-10-17T09:00:00Z', lastMsg: '2026-10-17T09:00:00Z', partnerChat: false },
  ],
  webChats: [
    { sessionId: 'a1b2c3d4-guest', userId: null, userMsgs: 2, authenticated: false, createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-20T08:00:00Z', referrerSource: null, utmSource: null, source: 'web', partner: null },
    { sessionId: 'widget_fishingkam_abc123', userId: null, userMsgs: 1, authenticated: false, createdAt: '2026-10-21T07:00:00Z', updatedAt: '2026-10-21T07:00:00Z', referrerSource: null, utmSource: null, source: 'widget', partner: 'Камчатская рыбалка' },
    { sessionId: 'safety-eval-1760900000000-benign-medkit', userId: null, userMsgs: 1, authenticated: false, createdAt: '2026-10-19T07:00:00Z', updatedAt: '2026-10-19T07:00:00Z', referrerSource: null, utmSource: null, source: 'probe', partner: null },
  ],
  a2aChats: [
    { dialogKey: 'ctx-1', agent: 'TravelAgent/2.1', kind: 'external', turns: 2, firstMsg: '2026-10-21T10:00:00Z', lastMsg: '2026-10-21T10:05:00Z' },
    { dialogKey: 'row:7', agent: 'A2A-Registry-TaskProbe/1.0', kind: 'registry', turns: 1, firstMsg: '2026-10-21T08:00:00Z', lastMsg: '2026-10-21T08:00:00Z' },
  ],
};

const SUMMARY = {
  success: true,
  data: {
    today: '2026-10-22', yesterday: '2026-10-21',
    people: { ok: false, error: 'не загрузилось' }, mcp: { ok: false, error: 'не загрузилось' }, a2a: { ok: false, error: 'не загрузилось' },
    kuzmich: { ok: true, today: { answers: 0, by_surface: {} }, yesterday: { answers: 3, by_surface: { a2a: 2, telegram: 1 } } },
  },
};

function stub(summary: unknown = SUMMARY) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (String(url).startsWith('/api/admin/analytics/day-summary') ? summary : CHATS),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openChats() {
  const { ChatsSection } = await import('@/app/hub/admin/ai-usage/_KuzmichAnalyticsClient');
  render(React.createElement(ChatsSection));
  fireEvent.click(screen.getByRole('button', { name: /Переписки/ }));
  await screen.findByText(/Ответов Кузьмича сегодня/);
}

/** Строки списка в порядке документа: [вход, имя, счётчик]. */
function rows(): string[][] {
  return screen.getAllByRole('button')
    .filter((b) => /сообщ\.|вопр\./.test(b.textContent ?? ''))
    .map((b) => {
      const spans = b.querySelectorAll('span');
      const count = within(b).getAllByText(/сообщ\.|вопр\./)[0].textContent ?? '';
      return [spans[0].textContent ?? '', spans[1].textContent ?? '', count];
    });
}

describe('«Переписки» Кузьмича — кто откуда', () => {
  it('у каждого разговора вход словами; A2A в общем списке; свежие сверху', async () => {
    stub();
    await openChats();
    expect(screen.getByText('(8 чатов)')).toBeTruthy();
    expect(rows()).toEqual([
      ['A2A', 'TravelAgent/2.1', '2 вопр.'],
      ['TG', 'Иван', '1 сообщ.'],
      ['A2A', 'A2A-Registry-TaskProbe/1.0 · реестр A2A', '1 вопр.'],
      ['Виджет', 'сайт партнёра: Камчатская рыбалка', '1 сообщ.'],
      ['Сайт', 'Гость', '2 сообщ.'],
      ['Проверка', 'проверка безопасности Кузьмича', '1 сообщ.'],
      // Чат партнёра и WhatsApp сохраняются с 1314 — и названы своим входом.
      ['TG', 'Оператор · чат партнёра', '3 сообщ.'],
      ['WhatsApp', 'Гость WA', '1 сообщ.'],
    ]);
  });

  it('ответы суток по входам — тем же счётом, что плитка обзора', async () => {
    stub();
    await openChats();
    expect(screen.getByText('Ответов Кузьмича сегодня: 0')).toBeTruthy();
    expect(screen.getByText('Вчера: 3 — A2A 2 · Telegram 1')).toBeTruthy();
  });

  it('диалог A2A открывается своей перепиской по ключу', async () => {
    const fetchMock = stub();
    await openChats();
    fireEvent.click(screen.getByRole('button', { name: /TravelAgent\/2\.1/ }));
    await screen.findByText('Нет сообщений');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/ai-analytics/chats?chat_id=ctx-1&platform=a2a');
  });

  it('сводка не прочиталась — так и сказано, список на месте', async () => {
    stub({ success: false, error: 'нет доступа' });
    const { ChatsSection } = await import('@/app/hub/admin/ai-usage/_KuzmichAnalyticsClient');
    render(React.createElement(ChatsSection));
    fireEvent.click(screen.getByRole('button', { name: /Переписки/ }));
    expect(await screen.findByText('Ответы по входам: не загрузилось.')).toBeTruthy();
    expect(screen.getByText('сайт партнёра: Камчатская рыбалка')).toBeTruthy();
  });
});
