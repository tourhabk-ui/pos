// @vitest-environment jsdom
/**
 * Переписка адресата заявки и клиента (1349, 1350; слово владельца 30.10:
 * «Единый чат для всех»): правила, тексты и экраны — рендером.
 *
 * Держит:
 *  - кнопка и ссылка «Старт» разбираются строго: чужая форма — не действие;
 *    кнопки жилья (`sq:`, уже ушедшие в MAX с 1349) и лида (`lq:`) — одно
 *    действие вебхука, незаверенное нажатие получает свой текст, а не молчание;
 *  - адресат назван по роли: перевозчик, прокат, гид, туроператор, владелец;
 *  - текст человека и желаемые даты экранируются, в заглушку для Telegram не
 *    попадают ни имя клиента, ни текст; клиенту не уходит имя клиента;
 *  - «не дошло» не выдаётся за «отправлено» (§4.0);
 *  - экран клиента: сообщения, пусто, «переписки по этой ссылке нет»,
 *    «не загрузилась», отправка, ссылка MAX;
 *  - ссылки после отправки формы: страница и MAX, «ключ не выдался» словами.
 * Путь записи и доставки на настоящей базе — tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  REQUEST_CHAT_MAX_LEN, REQUEST_CHAT_WAIT_MIN, chatPressPayload, counterpartDative, counterpartLabel, guestBoundText, guestBotLink,
  guestIncomingText, guestKeyFromStart, isCancelText, isChatPressPayload, leadDates, normalizeChatText,
  noPlaceToReadText, ownerIncomingStub, ownerIncomingText, ownerReplyButton, parseChatPress, platformIncomingStub, platformIncomingText, roleOfCategory,
  sentReplyText, stayDates, waitPrompt, type ChatFacts,
} from '@/lib/requests/request-chat';
import { pressActionOf, startActionOf, UNVERIFIED_PRESS_REPLY, PRESS_WITHOUT_MESSAGE_REPLY } from '@/lib/max/verified-press';
import { RequestChat } from '@/components/requests/RequestChat';
import { RequestChatLinks } from '@/components/requests/RequestChatLinks';

const ID = '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const STAY: ChatFacts = {
  target: 'stay', title: 'Кутха', dates: stayDates('2027-07-10', '2027-07-12'), people: 6,
  counterpartName: 'Кутха', role: 'stay',
};
const LEAD: ChatFacts = {
  target: 'lead', title: 'Вахтовка на Авачинский', dates: '30 октября', people: 12,
  counterpartName: 'Шатун', role: 'carrier',
};

describe('кнопка и ссылка', () => {
  it('кнопки жилья и лида туда и обратно; чужая форма — null', () => {
    expect(chatPressPayload('owner', { kind: 'stay', id: ID })).toBe(`sq:o:${ID}`);
    expect(chatPressPayload('guest', { kind: 'lead', id: ID })).toBe(`lq:g:${ID}`);
    expect(parseChatPress(`sq:o:${ID}`)).toEqual({ side: 'owner', target: { kind: 'stay', id: ID } });
    expect(parseChatPress(`sq:g:${ID}`)).toEqual({ side: 'guest', target: { kind: 'stay', id: ID } });
    expect(parseChatPress(`lq:o:${ID}`)).toEqual({ side: 'owner', target: { kind: 'lead', id: ID } });
    expect(parseChatPress(`lq:g:${ID}`)).toEqual({ side: 'guest', target: { kind: 'lead', id: ID } });
    expect(parseChatPress('sq:x:' + ID)).toBeNull();
    expect(parseChatPress('sq:o:123')).toBeNull();
    expect(parseChatPress(`lq:o:${ID}extra`)).toBeNull();
    expect(parseChatPress(`xq:o:${ID}`)).toBeNull();
  });

  it('ссылка «Старт» клиента: ключ 32 знака, можно набрать текстом с /start', () => {
    expect(guestKeyFromStart(`sq_${KEY}`)).toBe(KEY);
    expect(guestKeyFromStart(`/start sq_${KEY}`)).toBe(KEY);
    expect(guestKeyFromStart(`sq_${KEY}x`)).toBeNull();
    expect(guestKeyFromStart(`sr_${KEY}`)).toBeNull();
    expect(guestKeyFromStart('привет')).toBeNull();
    expect(guestBotLink('https://max.ru/bot', KEY)).toBe(`https://max.ru/bot?start=sq_${KEY}`);
  });

  it('вебхук MAX узнаёт обе кнопки как одно действие и ссылку; незаверенному — свой текст', () => {
    expect(isChatPressPayload(`sq:o:${ID}`)).toBe(true);
    expect(isChatPressPayload(`lq:g:${ID}`)).toBe(true);
    expect(isChatPressPayload('sr:y:1')).toBe(false);
    expect(pressActionOf(chatPressPayload('owner', { kind: 'stay', id: ID }))).toBe('request_chat');
    expect(pressActionOf(chatPressPayload('guest', { kind: 'lead', id: ID }))).toBe('request_chat');
    expect(pressActionOf('sr:y:1')).toBe('seat');
    expect(startActionOf(`sq_${KEY}`)).toBe('link');
    expect(UNVERIFIED_PRESS_REPLY.request_chat).toMatch(/не засчитано/);
    expect(PRESS_WITHOUT_MESSAGE_REPLY.request_chat).toMatch(/не засчитано/);
  });
});

describe('кто адресат', () => {
  it('роль — по категории партнёра; у заявки на жильё — всегда владелец', () => {
    expect(roleOfCategory('transfer', 'lead')).toBe('carrier');
    expect(roleOfCategory('cars', 'lead')).toBe('rental');
    expect(roleOfCategory('gear', 'lead')).toBe('rental');
    expect(roleOfCategory('operator', 'lead')).toBe('operator');
    expect(roleOfCategory('guide', 'lead')).toBe('guide');
    expect(roleOfCategory(null, 'lead')).toBe('partner');
    expect(roleOfCategory('operator', 'stay')).toBe('stay');
  });

  it('вывеска словами и кому писать', () => {
    expect(counterpartLabel(LEAD)).toBe('Перевозчик «Шатун»');
    expect(counterpartLabel({ counterpartName: null, role: 'guide' })).toBe('Гид');
    expect(counterpartDative('rental')).toBe('прокату');
    expect(counterpartDative('stay')).toBe('владельцу');
  });

  it('кнопка адресату: гостю у жилья, клиенту у лида', () => {
    expect(ownerReplyButton({ kind: 'stay', id: ID })).toEqual({ text: 'Ответить гостю', payload: `sq:o:${ID}` });
    expect(ownerReplyButton({ kind: 'lead', id: ID })).toEqual({ text: 'Ответить клиенту', payload: `lq:o:${ID}` });
  });

  it('желаемые даты лида — слова клиента: пробелы сжаты, длинное обрезано, пусто — нет дат', () => {
    expect(leadDates('  30   октября ')).toBe('30 октября');
    expect(leadDates('')).toBeNull();
    expect(leadDates(null)).toBeNull();
    const long = leadDates('а'.repeat(200));
    expect(long).toHaveLength(80);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('текст сообщения', () => {
  it('пусто и длинно — отказ словами; управляющие знаки вон', () => {
    expect(normalizeChatText('   ')).toMatchObject({ ok: false });
    expect(normalizeChatText(42)).toMatchObject({ ok: false });
    expect(normalizeChatText('a'.repeat(REQUEST_CHAT_MAX_LEN + 1))).toMatchObject({ ok: false });
    expect(normalizeChatText(' Привет\u0007\r\nмир ')).toEqual({ ok: true, text: 'Привет\nмир' });
  });

  it('«отмена» гасит, обычная фраза — нет', () => {
    expect(isCancelText('Отмена')).toBe(true);
    expect(isCancelText('не надо')).toBe(true);
    expect(isCancelText('отмена бронирования на 5 число')).toBe(false);
  });
});

describe('ПД и экранирование', () => {
  it('владельцу жилья: имя гостя и текст экранированы; в заглушку — ни имени, ни текста', () => {
    const t = ownerIncomingText(STAY, 'Анна <b>', 'Заезд <script>');
    expect(t).toContain('Сообщение гостя');
    expect(t).toContain('Анна &lt;b&gt;');
    expect(t).toContain('Заезд &lt;script&gt;');
    expect(t).toContain('«Ответить гостю»');
    const stub = ownerIncomingStub(STAY);
    expect(stub).not.toContain('Анна');
    expect(stub).not.toContain('Заезд');
  });

  it('перевозчику: «клиент», число людей, даты клиента экранированы', () => {
    const t = ownerIncomingText({ ...LEAD, dates: '<b>завтра</b>' }, 'Иван', 'Во сколько подача?');
    expect(t).toContain('Сообщение клиента по заявке: Вахтовка на Авачинский');
    expect(t).toContain('Клиент: Иван');
    expect(t).toContain('человек: 12');
    expect(t).toContain('&lt;b&gt;завтра');
    expect(t).not.toContain('<b>завтра');
    expect(t).toContain('«Ответить клиенту»');
    expect(ownerIncomingStub(LEAD)).not.toContain('Иван');
    // Не дошло до адресата — оператору платформы: кому передать и почему.
    const admin = platformIncomingText(LEAD, 'Иван', 'Во сколько подача?', 'MAX <ответил> 500');
    expect(admin).toContain('Адресат: Перевозчик «Шатун»');
    expect(admin).toContain('Причина: MAX &lt;ответил&gt; 500');
    expect(platformIncomingStub(LEAD)).toContain('Адресат: Перевозчик «Шатун»');
  });

  it('клиенту: ответ подписан вывеской адресата, вывеска экранирована, кнопка — «Написать перевозчику»', () => {
    const t = guestIncomingText({ ...LEAD, counterpartName: 'Шатун <x>' }, 'Ждём <i>');
    expect(t).toContain('Перевозчик «Шатун &lt;x&gt;»');
    expect(t).toContain('Ждём &lt;i&gt;');
    expect(t).toContain('Вахтовка на Авачинский');
    expect(t).toContain('«Написать перевозчику»');
    expect(guestIncomingText(STAY, 'да')).toContain('10.07.2027');
  });

  it('после кнопки — что делать и кому', () => {
    expect(waitPrompt('owner', LEAD)).toMatch(/^Напишите ответ клиенту по заявке «Вахтовка на Авачинский», 30 октября/);
    expect(waitPrompt('guest', STAY)).toMatch(/^Напишите сообщение владельцу по заявке «Кутха»/);
  });

  it('«не дошло» не выдаётся за «передал»', () => {
    expect(sentReplyText('owner', 'max', STAY)).toMatch(/Передал гостю/);
    expect(sentReplyText('owner', 'max', LEAD)).toMatch(/Передал клиенту/);
    expect(sentReplyText('owner', 'no_address', LEAD)).not.toMatch(/Передал/);
    expect(sentReplyText('owner', 'failed', LEAD)).not.toMatch(/Передал/);
    expect(sentReplyText('guest', 'max', LEAD)).toMatch(/Передал перевозчику/);
    expect(sentReplyText('guest', 'no_address', LEAD)).toMatch(/Перевозчик пока не подключил MAX.*оператор Ведара/);
    expect(sentReplyText('guest', 'failed', STAY)).not.toMatch(/^Передал/);
  });

  it('не получил и оператор Ведара; клиенту негде прочитать — сказано, а не «передал»', () => {
    expect(sentReplyText('guest', 'no_address', LEAD, { relayed: false })).toMatch(/не удалось — ни перевозчику, ни оператору Ведара/);
    expect(sentReplyText('guest', 'failed', LEAD, { relayed: false })).not.toMatch(/получил/);
    expect(sentReplyText('owner', 'no_address', LEAD, { pageVisible: false })).toMatch(/прочитать клиенту это негде.*Позвоните/);
    expect(sentReplyText('owner', 'failed', STAY, { pageVisible: false })).toMatch(/гостю это негде/);
    expect(noPlaceToReadText(LEAD)).toMatch(/^Ответ клиенту прочитать негде.*ничего не отправлено\.$/);
    expect(noPlaceToReadText(STAY)).toMatch(/^Ответ гостю/);
  });

  it('заглушка Telegram: телефон, вписанный в направление или даты, не уходит', () => {
    const f: ChatFacts = { ...LEAD, title: 'Вахтовка: заберите у дома, +7 914 123-45-67', dates: '30 октября, звоните 89141234567' };
    for (const t of [ownerIncomingStub(f), platformIncomingStub(f)]) {
      expect(t).not.toMatch(/914[ -]?123|9141234567/);
    }
    // В MAX адресату (ПД разрешены) — как есть.
    expect(ownerIncomingText(f, 'Иван', 'да')).toContain('+7 914 123-45-67');
  });

  it('окно после кнопки — 15 минут, как у причины отказа брони', () => {
    expect(REQUEST_CHAT_WAIT_MIN).toBe(15);
    expect(waitPrompt('owner', LEAD)).toMatch(/Ждём 15 минут/);
  });

  it('клиенту после «Старта»: есть ответ — сказано, нет — как написать', () => {
    expect(guestBoundText(LEAD, 0)).toMatch(/Перевозчик «Шатун».*«Написать перевозчику»/);
    expect(guestBoundText(LEAD, 2)).toMatch(/Уже есть ответ/);
  });
});

// ── Экран клиента ────────────────────────────────────────────────────────────

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CHAT = {
  available: true, kind: 'lead', title: 'Вахтовка на Авачинский', dates: '30 октября', people: 12,
  counterpart_label: 'Перевозчик «Шатун»', to_label: 'перевозчику',
  guest_on_max: false, owner_on_max: true, max_link: `https://max.ru/bot?start=sq_${KEY}`,
  messages: [
    { author: 'guest', body: 'Во сколько подача?', at: '2026-10-29T10:00:00.000Z' },
    { author: 'owner', body: 'В 7:00 у гостиницы', at: '2026-10-29T10:05:00.000Z' },
  ],
};

beforeEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран переписки на странице заявки', () => {
  it('сообщения с авторами, адресат по вывеске и ссылка подключить MAX; запрос — с ключом', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: CHAT }));
    render(<RequestChat requestKey={KEY} />);
    expect(await screen.findByText('Во сколько подача?')).toBeInTheDocument();
    expect(screen.getByText('В 7:00 у гостиницы')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Переписка: Перевозчик «Шатун»' })).toBeInTheDocument();
    expect(screen.getByText(/^Перевозчик «Шатун» ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Вы ·/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Подключить MAX' })).toHaveAttribute('href', CHAT.max_link);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/requests/chat?k=${KEY}`);
  });

  it('пусто — говорит, кому можно написать; MAX подключён — ссылки нет', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { ...CHAT, messages: [], guest_on_max: true, max_link: null } }));
    render(<RequestChat requestKey={KEY} />);
    expect(await screen.findByText(/Сообщений пока нет\. Напишите перевозчику/)).toBeInTheDocument();
    expect(screen.getByText(/MAX подключён/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Подключить MAX' })).not.toBeInTheDocument();
  });

  it('переписки по этой ссылке нет — причина словами, поля ввода нет', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { available: false, reason: 'По этой ссылке видно только состояние заявки.' } }));
    render(<RequestChat requestKey={KEY} />);
    expect(await screen.findByText('По этой ссылке видно только состояние заявки.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument();
  });

  it('не загрузилась — так и сказано, а не «сообщений нет»', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Не удалось прочитать переписку' }, 503));
    render(<RequestChat requestKey={KEY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Переписка не загрузилась/);
    expect(screen.queryByText(/Сообщений пока нет/)).not.toBeInTheDocument();
  });

  it('отправка: текст и ключ уходят POST; итог доставки назван', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return json({ success: true, data: { delivery: 'no_address' } });
      return json({ success: true, data: CHAT });
    });
    render(<RequestChat requestKey={KEY} />);
    await screen.findByText('В 7:00 у гостиницы');
    fireEvent.change(screen.getByLabelText('Сообщение перевозчику'), { target: { value: 'Спасибо' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText(/оператор Ведара и передаст/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(post?.[0]).toBe('/api/requests/chat');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ k: KEY, text: 'Спасибо' });
  });

  it('доставлено в MAX — «передано» с адресатом', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return json({ success: true, data: { delivery: 'max' } });
      return json({ success: true, data: CHAT });
    });
    render(<RequestChat requestKey={KEY} />);
    await screen.findByText('В 7:00 у гостиницы');
    fireEvent.change(screen.getByLabelText('Сообщение перевозчику'), { target: { value: 'Ок' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText('Передано: Перевозчик «Шатун».')).toBeInTheDocument();
  });

  it('отказ отправки — текст ошибки, поле не очищается', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return json({ success: false, error: 'Слишком много сообщений подряд' }, 429);
      return json({ success: true, data: CHAT });
    });
    render(<RequestChat requestKey={KEY} />);
    await screen.findByText('В 7:00 у гостиницы');
    const box = screen.getByLabelText('Сообщение перевозчику');
    fireEvent.change(box, { target: { value: 'Ещё вопрос' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(screen.getByText('Слишком много сообщений подряд')).toBeInTheDocument());
    expect(box).toHaveValue('Ещё вопрос');
  });
});

describe('ссылки после отправки формы', () => {
  const PAGE = `https://vedarai.ru/request-status#${KEY}`;
  const MAXL = `https://max.ru/bot?start=sq_${KEY}`;

  it('страница заявки и MAX — кнопки: ключа в разметке нет (Вебвизор), MAX в новой вкладке', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = render(<RequestChatLinks page={PAGE} maxLink={MAXL} />);
    expect(container.innerHTML).not.toContain(KEY);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Переписка по заявке' }));
    expect(open).toHaveBeenLastCalledWith(PAGE, '_self');
    fireEvent.click(screen.getByRole('button', { name: 'Получать ответы в MAX' }));
    expect(open).toHaveBeenLastCalledWith(MAXL, '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('форма в виджете на чужом сайте — и страница в новой вкладке; без MAX — одна кнопка', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<RequestChatLinks page={PAGE} maxLink={null} newTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Переписка по заявке' }));
    expect(open).toHaveBeenLastCalledWith(PAGE, '_blank', 'noopener,noreferrer');
    expect(screen.queryByRole('button', { name: 'Получать ответы в MAX' })).not.toBeInTheDocument();
    open.mockRestore();
  });

  it('ключ не выдался — сказано словами, кнопок нет', () => {
    render(<RequestChatLinks page={null} maxLink={null} />);
    expect(screen.getByText(/Ссылка на переписку не выдалась/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
