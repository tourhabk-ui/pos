/**
 * Ссылки подключения в Telegram-обработчике Кузьмича (15.10).
 *
 * Снимок владельца 15.10: оператор «Местечко Камчатка» ответил на ссылку
 * подключения «Ссылка на телегу не рабочая», MAX при этом подключился. У
 * @kuzmichai_bot два обработчика: /api/telegram/webhook понимал
 * `/start op_…`, /api/telegram/kuzmich знал только голый `/start` — ссылка с
 * аргументом уходила в туристский поток, и человек видел ответ Кузьмича
 * вместо привязки. Теперь оба обработчика ведут ссылки op_/om_/sr_ одной
 * цепочкой (bind-channel, member-channel, seat-requests).
 *
 * Сторож — вызов роута с настоящим подписанным токеном op_ (HMAC из
 * lib/partners/channel-link): что увидит оператор, нажав «Старт». База и
 * транспорт Telegram подменены, разбор ссылки и запись адреса — настоящие.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  processMessage: vi.fn(),
  processPartner: vi.fn(),
  findPartner: vi.fn(),
  memberStart: vi.fn(),
  bindTourist: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/kuzmich/core', () => ({
  // Живого черновика заявки нет: развилка чата судится без него.
  hasLiveBookingFlow: vi.fn(async () => false),
  cleanupPending: vi.fn(), processMessage: m.processMessage, isBookingTrigger: () => false,
  KUZMICH_SYSTEM: '', buildTourContext: vi.fn(),
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: m.findPartner,
  partnerGreeting: () => 'Здравствуйте, это ваш кабинет',
  processPartnerMessage: m.processPartner,
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
}));
vi.mock('@/lib/agents', () => ({ PlatformAgent: class {} }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok' }));
vi.mock('@/lib/platform-settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('@/lib/html/text', () => ({ stripTags: (s: string) => s }));
vi.mock('@/lib/operators/member-channel', () => ({ handleMemberStart: m.memberStart }));
vi.mock('@/lib/seat-requests/service', () => ({
  bindTouristChat: m.bindTourist, answerSeatRequest: vi.fn(), requestBelongsToMaxChat: vi.fn(),
}));
// Уведомления о перепривязке (администратору и прежнему чату) — не предмет теста.
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => ({ success: true })) } }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: vi.fn(async () => ({ ok: true })) }));

import { createPartnerLinkToken, PARTNER_LINK_PREFIX } from '@/lib/partners/channel-link';
import { TOURIST_START_PREFIX } from '@/lib/seat-requests/core';

const route = await import('@/app/api/telegram/kuzmich/route');

const PARTNER_ID = '0f2a7f0e-3f5d-4c1a-9b0e-7d4b2a1c5e6f';
const CHAT = 4242;

function update(text: string, chat: { id: number; type: string } = { id: CHAT, type: 'private' }) {
  return new NextRequest('http://localhost/api/telegram/kuzmich', {
    method: 'POST',
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: { message_id: 1, from: { id: chat.id, first_name: 'Павел' }, chat, text },
    }),
  });
}

/** Тексты, ушедшие в Telegram через sendMessage (tgReply роута). */
function sentTexts(): string[] {
  return m.fetch.mock.calls
    .filter(([url]) => String(url).includes('/sendMessage'))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { text: string }).text);
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('CONNECT_TOKEN_SECRET', 'test-secret-for-partner-links-16');
  vi.stubEnv('TELEGRAM_OWNER_ID', '1');
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', m.fetch);
  m.findPartner.mockResolvedValue({ outcome: 'not_found' });
  m.memberStart.mockResolvedValue(false);
  m.bindTourist.mockResolvedValue({ ok: true, notified: false });
  // UPDATE partners … RETURNING name, previous — оператор найден, прежнего чата нет.
  m.query.mockResolvedValue({ rows: [{ name: 'Местечко Камчатка', previous: null }] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('Кузьмич в Telegram ведёт ссылки подключения, как вебхук и MAX', () => {
  it('«Старт» по ссылке op_ оператора: адрес записан в карточку партнёра, ответ — «Telegram подключён»', async () => {
    const t = createPartnerLinkToken(PARTNER_ID);
    if (!t.ok) throw new Error(t.reason);
    const res = await route.POST(update(`/start ${PARTNER_LINK_PREFIX}${t.token}`));
    expect(res.status).toBe(200);

    const upd = m.query.mock.calls.find(([sql]) => /UPDATE partners/.test(sql as string));
    expect(upd, 'привязка должна дойти до записи адреса').toBeTruthy();
    expect(upd![0]).toMatch(/SET telegram_chat_id = \$1::bigint/);
    expect(upd![1]).toEqual([String(CHAT), PARTNER_ID]);

    expect(sentTexts().join('\n')).toMatch(/Telegram подключён к оператору «Местечко Камчатка»/);
    expect(m.processMessage, 'в туристский поток ссылка не уходит').not.toHaveBeenCalled();
    expect(m.processPartner).not.toHaveBeenCalled();
  });

  it('ссылка с неверной подписью — честный отказ, адрес не пишется', async () => {
    const res = await route.POST(update(`/start ${PARTNER_LINK_PREFIX}${'A'.repeat(43)}`));
    expect(res.status).toBe(200);
    expect(m.query.mock.calls.some(([sql]) => /UPDATE partners/.test(sql as string))).toBe(false);
    expect(sentTexts().join('\n')).toMatch(/Ссылка для подключения недействительна/);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('уже привязанный чат партнёра по новой ссылке перепривязывается, а не получает приветствие', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { id: PARTNER_ID, name: 'Местечко Камчатка' } });
    const t = createPartnerLinkToken(PARTNER_ID);
    if (!t.ok) throw new Error(t.reason);
    await route.POST(update(`/start ${PARTNER_LINK_PREFIX}${t.token}`));
    expect(m.query.mock.calls.some(([sql]) => /UPDATE partners/.test(sql as string))).toBe(true);
    expect(sentTexts().join('\n')).not.toMatch(/это ваш кабинет/);
  });

  it('ссылка менеджера om_ уходит в привязку менеджера с этим чатом', async () => {
    m.memberStart.mockResolvedValue(true);
    await route.POST(update('/start om_tok'));
    expect(m.memberStart).toHaveBeenCalledWith('om_tok', 'telegram', CHAT, expect.any(Function));
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('ссылка туриста sr_: чат привязан к запросу мест, человеку сказано, когда ждать ответ', async () => {
    const key = 'k'.repeat(32);
    await route.POST(update(`/start ${TOURIST_START_PREFIX}${key}`));
    expect(m.bindTourist).toHaveBeenCalledWith(key, 'telegram', CHAT);
    expect(sentTexts().join('\n')).toMatch(/ответ оператора придёт сюда/);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('привязанный чат: аренда машины — Кузьмич туриста, не помощник CRM', async () => {
    m.findPartner.mockResolvedValue({
      outcome: 'found',
      partner: { partnerId: PARTNER_ID, partnerName: 'Лагуна', category: 'operator', crmCategory: 'operator', userId: 'u1', slug: 'laguna-prokat' },
    });
    await route.POST(update('найди мне в аренду автомобиль'));
    expect(m.processPartner).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: CHAT, text: 'найди мне в аренду автомобиль', mode: 'tourist',
    }));
  });

  it('привязанный чат: «запиши» остаётся помощнику CRM', async () => {
    m.findPartner.mockResolvedValue({
      outcome: 'found',
      partner: { partnerId: PARTNER_ID, partnerName: 'Лагуна', category: 'operator', crmCategory: 'operator', userId: 'u1', slug: 'laguna-prokat' },
    });
    await route.POST(update('запиши, что звонил'));
    expect(m.processMessage).not.toHaveBeenCalled();
    expect(m.processPartner).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT, text: 'запиши, что звонил' }));
  });

  it('голый /start — приветствие туристу, как прежде: ни одной привязки', async () => {
    await route.POST(update('/start'));
    expect(m.query.mock.calls.some(([sql]) => /UPDATE partners/.test(sql as string))).toBe(false);
    expect(m.memberStart).not.toHaveBeenCalled();
    expect(m.bindTourist).not.toHaveBeenCalled();
    expect(sentTexts().length).toBeGreaterThan(0);
  });

  it('голое сообщение op_ подключает так же, как «Старт» по ссылке', async () => {
    const t = createPartnerLinkToken(PARTNER_ID);
    if (!t.ok) throw new Error(t.reason);
    const res = await route.POST(update(`${PARTNER_LINK_PREFIX}${t.token}`));
    expect(res.status).toBe(200);
    const upd = m.query.mock.calls.find(([sql]) => /UPDATE partners/.test(sql as string));
    expect(upd?.[1]).toEqual([String(CHAT), PARTNER_ID]);
    expect(sentTexts().join('\n')).toMatch(/Telegram подключён к оператору «Местечко Камчатка»/);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('/start@бот op_ тоже подключает: клиент присылает имя бота в команде', async () => {
    const t = createPartnerLinkToken(PARTNER_ID);
    if (!t.ok) throw new Error(t.reason);
    await route.POST(update(`/start@kuzmichai_bot ${PARTNER_LINK_PREFIX}${t.token}`));
    expect(m.query.mock.calls.some(([sql]) => /UPDATE partners/.test(sql as string))).toBe(true);
    expect(sentTexts().join('\n')).toMatch(/Telegram подключён/);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('op_ внутри фразы туриста — не код привязки', async () => {
    const t = createPartnerLinkToken(PARTNER_ID);
    if (!t.ok) throw new Error(t.reason);
    await route.POST(update(`хочу тур, вот код ${PARTNER_LINK_PREFIX}${t.token}`));
    expect(m.query.mock.calls.some(([sql]) => /UPDATE partners/.test(sql as string))).toBe(false);
    expect(m.processMessage).toHaveBeenCalled();
  });

  it('в группе ссылка op_ никого не подключает', async () => {
    const t = createPartnerLinkToken(PARTNER_ID);
    if (!t.ok) throw new Error(t.reason);
    await route.POST(update(`/start ${PARTNER_LINK_PREFIX}${t.token}`, { id: -100500, type: 'supergroup' }));
    expect(m.query.mock.calls.some(([sql]) => /UPDATE partners/.test(sql as string))).toBe(false);
  });
});
