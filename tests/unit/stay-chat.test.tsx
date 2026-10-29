// @vitest-environment jsdom
/**
 * Переписка хозяина жилья и гостя по заявке (1348, #2843): правила, тексты и
 * экран гостя — рендером.
 *
 * Держит:
 *  - кнопка и ссылка «Старт» разбираются строго: чужая форма — не действие;
 *  - вебхук MAX узнаёт кнопку `sq:` и ссылку `sq_`, а незаверенное нажатие
 *    получает свой текст, а не молчание;
 *  - текст человека экранируется, в заглушку для Telegram не попадают ни имя
 *    гостя, ни текст; гостю не уходит имя гостя;
 *  - «не дошло» не выдаётся за «отправлено» (§4.0);
 *  - экран гостя: сообщения, пусто, «не загрузилась», отправка, ссылка MAX.
 * Путь записи и доставки на настоящей базе — tests/integration/stay-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  STAY_CHAT_MAX_LEN, guestIncomingText, isCancelText, normalizeChatText, ownerIncomingStub, ownerIncomingText,
  parseStayChatPress, sentReplyText, stayChatPressPayload, stayGuestBotLink, stayKeyFromStart,
} from '@/lib/stay/stay-chat';
import { pressActionOf, startActionOf, UNVERIFIED_PRESS_REPLY, PRESS_WITHOUT_MESSAGE_REPLY } from '@/lib/max/verified-press';
import { StayChat } from '@/components/stay/StayChat';

const ID = '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FACTS = { accommodationName: 'Кутха', checkIn: '2027-07-10', checkOut: '2027-07-12', guests: 6 };

describe('кнопка и ссылка', () => {
  it('кнопка хозяина и гостя туда и обратно; чужая форма — null', () => {
    expect(parseStayChatPress(stayChatPressPayload('owner', ID))).toEqual({ side: 'owner', requestId: ID });
    expect(parseStayChatPress(stayChatPressPayload('guest', ID))).toEqual({ side: 'guest', requestId: ID });
    expect(parseStayChatPress('sq:x:' + ID)).toBeNull();
    expect(parseStayChatPress('sq:o:123')).toBeNull();
    expect(parseStayChatPress(`sq:o:${ID}extra`)).toBeNull();
  });

  it('ссылка «Старт» гостя: ключ 32 знака, можно набрать текстом с /start', () => {
    expect(stayKeyFromStart(`sq_${KEY}`)).toBe(KEY);
    expect(stayKeyFromStart(`/start sq_${KEY}`)).toBe(KEY);
    expect(stayKeyFromStart(`sq_${KEY}x`)).toBeNull();
    expect(stayKeyFromStart(`sr_${KEY}`)).toBeNull();
    expect(stayKeyFromStart('привет')).toBeNull();
    expect(stayGuestBotLink('https://max.ru/bot', KEY)).toBe(`https://max.ru/bot?start=sq_${KEY}`);
  });

  it('вебхук MAX узнаёт кнопку и ссылку; незаверенному — свой текст', () => {
    expect(pressActionOf(stayChatPressPayload('owner', ID))).toBe('stay_chat');
    expect(pressActionOf('sr:y:1')).toBe('seat');
    expect(startActionOf(`sq_${KEY}`)).toBe('link');
    expect(UNVERIFIED_PRESS_REPLY.stay_chat).toMatch(/не засчитано/);
    expect(PRESS_WITHOUT_MESSAGE_REPLY.stay_chat).toMatch(/не засчитано/);
  });
});

describe('текст сообщения', () => {
  it('пусто и длинно — отказ словами; управляющие знаки вон', () => {
    expect(normalizeChatText('   ')).toMatchObject({ ok: false });
    expect(normalizeChatText(42)).toMatchObject({ ok: false });
    expect(normalizeChatText('a'.repeat(STAY_CHAT_MAX_LEN + 1))).toMatchObject({ ok: false });
    expect(normalizeChatText(' Привет\u0007\r\nмир ')).toEqual({ ok: true, text: 'Привет\nмир' });
  });

  it('«отмена» гасит, обычная фраза — нет', () => {
    expect(isCancelText('Отмена')).toBe(true);
    expect(isCancelText('не надо')).toBe(true);
    expect(isCancelText('отмена бронирования на 5 число')).toBe(false);
  });
});

describe('ПД и экранирование', () => {
  it('хозяину: имя гостя и текст экранированы; в заглушку — ни имени, ни текста', () => {
    const t = ownerIncomingText(FACTS, 'Анна <b>', 'Заезд <script>');
    expect(t).toContain('Анна &lt;b&gt;');
    expect(t).toContain('Заезд &lt;script&gt;');
    const stub = ownerIncomingStub(FACTS);
    expect(stub).not.toContain('Анна');
    expect(stub).not.toContain('Заезд');
  });

  it('гостю: текст владельца экранирован, имени гостя нет по построению', () => {
    const t = guestIncomingText(FACTS, 'Ждём <i>');
    expect(t).toContain('Ждём &lt;i&gt;');
    expect(t).toContain('Кутха');
    expect(t).toContain('10.07.2027');
  });

  it('«не дошло» не выдаётся за «передал»', () => {
    expect(sentReplyText('owner', 'max')).toMatch(/Передал гостю/);
    expect(sentReplyText('owner', 'no_address')).not.toMatch(/Передал/);
    expect(sentReplyText('owner', 'failed')).not.toMatch(/Передал/);
    expect(sentReplyText('guest', 'no_address')).toMatch(/оператор Ведара/);
    expect(sentReplyText('guest', 'failed')).not.toMatch(/^Передал/);
  });
});

// ── Экран гостя ──────────────────────────────────────────────────────────────

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CHAT = {
  accommodation: 'Кутха', check_in: '2027-07-10', check_out: '2027-07-12', guests: 6,
  guest_on_max: false, owner_on_max: true, max_link: `https://max.ru/bot?start=sq_${KEY}`,
  messages: [
    { author: 'guest', body: 'Можно заехать в 12?', at: '2026-10-29T10:00:00.000Z' },
    { author: 'owner', body: 'Да, ждём', at: '2026-10-29T10:05:00.000Z' },
  ],
};

beforeEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран переписки на странице заявки', () => {
  it('сообщения с авторами и ссылка подключить MAX; запрос — с ключом', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: CHAT }));
    render(<StayChat requestKey={KEY} />);
    expect(await screen.findByText('Можно заехать в 12?')).toBeInTheDocument();
    expect(screen.getByText('Да, ждём')).toBeInTheDocument();
    expect(screen.getByText(/Владелец · Кутха/)).toBeInTheDocument();
    expect(screen.getByText(/^Вы ·/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Подключить MAX' })).toHaveAttribute('href', CHAT.max_link);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/requests/stay-chat?k=${KEY}`);
  });

  it('пусто — говорит, что можно написать; MAX подключён — ссылки нет', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { ...CHAT, messages: [], guest_on_max: true, max_link: null } }));
    render(<StayChat requestKey={KEY} />);
    expect(await screen.findByText(/Сообщений пока нет/)).toBeInTheDocument();
    expect(screen.getByText(/MAX подключён/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Подключить MAX' })).not.toBeInTheDocument();
  });

  it('не загрузилась — так и сказано, а не «сообщений нет»', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Не удалось прочитать переписку' }, 503));
    render(<StayChat requestKey={KEY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Переписка не загрузилась/);
    expect(screen.queryByText(/Сообщений пока нет/)).not.toBeInTheDocument();
  });

  it('отправка: текст и ключ уходят POST; итог доставки назван', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return json({ success: true, data: { delivery: 'no_address' } });
      return json({ success: true, data: CHAT });
    });
    render(<StayChat requestKey={KEY} />);
    await screen.findByText('Да, ждём');
    fireEvent.change(screen.getByLabelText('Сообщение владельцу'), { target: { value: 'Спасибо' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText(/оператор Ведара и передаст/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(post?.[0]).toBe('/api/requests/stay-chat');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ k: KEY, text: 'Спасибо' });
  });

  it('отказ отправки — текст ошибки, поле не очищается', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return json({ success: false, error: 'Слишком много сообщений подряд' }, 429);
      return json({ success: true, data: CHAT });
    });
    render(<StayChat requestKey={KEY} />);
    await screen.findByText('Да, ждём');
    const box = screen.getByLabelText('Сообщение владельцу');
    fireEvent.change(box, { target: { value: 'Ещё вопрос' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(screen.getByText('Слишком много сообщений подряд')).toBeInTheDocument());
    expect(box).toHaveValue('Ещё вопрос');
  });
});
