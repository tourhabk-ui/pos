/**
 * Экраны гида со своими турами в привязанном чате (29.10, шаг 5 плана «гид в
 * мессенджере»): «Брони» и «Мои туры» — те же чтения, что раздел «Свои туры»
 * на сайте (loadOwnBookings, loadOwnTours).
 *
 * Что держит — вызовом функций и живых входов (POST /api/max/kuzmich,
 * POST /api/telegram/webhook), подменены только база, чтения раздела и
 * транспорт:
 *  - в Telegram-тексте броней нет ни имени, ни телефона, ни почты, ни особых
 *    пожеланий туриста — ни через функцию, ни через кнопку, ни через команду;
 *  - в MAX имя и телефон уходят только через sendPdAlert в чат этого
 *    сообщения, без заглушки в Telegram (`telegramChatId: null`); обычным
 *    ответом — никогда; не доставились — строка без ПД;
 *  - кнопки и команда броней — только в личном диалоге; в группе отказ до
 *    чтения броней;
 *  - гид команды оператора без своих туров «Броней» и «Моих туров» не
 *    получает — ни в строке, ни по устаревшей кнопке;
 *  - отказ базы — «не прочитались», а не «броней нет» (§4.0);
 *  - после привязки гид видит под ответом свою строку меню в обоих каналах, а
 *    в Telegram — команды чата из той же строки.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { OwnBooking, OwnTour } from '@/lib/guides/own-tours';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  pool: vi.fn(),
  db: vi.fn(),
  processMessage: vi.fn(),
  processPartner: vi.fn(),
  findPartner: vi.fn(),
  findAdmin: vi.fn(),
  pdAlert: vi.fn(),
  bookings: vi.fn(),
  tours: vi.fn(),
  tgSend: vi.fn(),
  maxDm: vi.fn(),
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: vi.fn(), answerOnCallback: vi.fn(async () => ({})) } }),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.pool(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/kuzmich/core', () => ({ hasLiveBookingFlow: vi.fn(async () => false), processMessage: m.processMessage, cleanupPending: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/operator-chat')>()),
  findPartnerByChat: m.findPartner,
  processPartnerMessage: m.processPartner,
}));
vi.mock('@/lib/max/admin-link', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: m.findAdmin,
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: m.pdAlert }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: m.maxDm }));
vi.mock('@/lib/guides/own-tours', async (orig) => ({
  ...(await orig<typeof import('@/lib/guides/own-tours')>()),
  loadOwnBookings: m.bookings,
  loadOwnTours: m.tours,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'test_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));

const screens = await import('@/lib/guides/chat-screens');
const { roleMenuScreen, GUIDE_NO_OWN_TOURS, PARTNER_PD_UNDELIVERED } = await import('@/lib/roles/role-screen');
const { partnerMenu } = await import('@/lib/roles/role-menu');
const { roleChatCommands } = await import('@/lib/telegram/role-commands');
const { createPartnerLinkToken } = await import('@/lib/partners/channel-link');
const max = await import('@/app/api/max/kuzmich/route');
const telegram = await import('@/app/api/telegram/webhook/route');
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

// ── Данные: выдуманные турист и тур ─────────────────────────────────────────

const NAME = 'Турист Пробный';
const PHONE = '+70000000077';
const EMAIL = 'pd-probe@example.com';
const WISH = 'аллергия на орехи';
const PD = [NAME, PHONE, '0000000077', EMAIL, WISH];
/** 29.10 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 9, 29, 0, 0);

function bk(over: Partial<OwnBooking>): OwnBooking {
  return {
    id: '501', tour_id: '77', tour_title: 'Пещеры <Камчатки>', booking_date: '2026-11-05', participants: 2,
    booking_status: 'new', tourist_name: NAME, tourist_phone: PHONE, tourist_email: EMAIL,
    special_requests: WISH, created_at: '2026-10-28 10:00:00+12', ...over,
  };
}

const ROWS: OwnBooking[] = [
  bk({}),
  bk({ id: '502', booking_status: 'confirmed', booking_date: '2026-11-02' }),
  bk({ id: '503', booking_status: 'pending_payment', booking_date: '2026-11-04' }),
  bk({ id: '504', booking_status: 'cancelled', booking_date: '2026-11-03' }),
  bk({ id: '505', booking_status: 'confirmed', booking_date: '2026-12-20' }),
];

function tour(over: Partial<OwnTour>): OwnTour {
  return {
    id: '77', title: 'Пещеры <Камчатки>', slug: 'caves', is_published: true, is_active: true, base_price: '15000',
    max_participants: 6, season_start: null, season_end: null, open_dates: 4, ...over,
  };
}

const SELLER = {
  partnerId: '44444444-4444-4444-8444-444444444444',
  partnerName: 'Гид-продавец',
  slug: 'guide-seller',
  category: 'guide',
  crmCategory: 'guide',
  userId: null,
  sellsTours: true,
};
const TEAM_GUIDE = { ...SELLER, partnerName: 'Гид команды', slug: 'team-guide', sellsTours: false };

const noPd = (text: string) => { for (const v of PD) expect(text).not.toContain(v); };

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearMaxMessageDedup();
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.pool.mockResolvedValue({ rows: [] });
  m.db.mockResolvedValue({ rows: [] });
  m.findPartner.mockResolvedValue({ outcome: 'found', partner: SELLER });
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено в MAX' });
  m.bookings.mockResolvedValue(ROWS);
  m.tours.mockResolvedValue([tour({})]);
  m.tgSend.mockResolvedValue({ success: true });
  m.maxDm.mockResolvedValue({ ok: true });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tg-test-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// ── Экраны вызовом функций ──────────────────────────────────────────────────

describe('экран «Брони» гида', () => {
  it('Telegram: ни имени, ни телефона, ни почты, ни пожеланий — даже когда чтение вернуло их', async () => {
    const screen = await screens.guideBookingsScreen(SELLER.partnerId, 'telegram', NOW);
    expect(m.bookings).toHaveBeenCalledWith(SELLER.partnerId);
    expect(screen.pd).toBe(false);
    noPd(screen.text);
    expect(screen.text).toContain('Ждут вашего ответа: 1.');
    expect(screen.text).toContain('№501 · Пещеры &lt;Камчатки&gt; · 05.11 · 2 чел');
    expect(screen.text).toContain('Имя и телефон туриста — в MAX и в кабинете.');
    expect(screen.text).toContain('/hub/guide/own');
  });

  it('MAX: имя и телефон есть, почты и пожеланий нет; экран помечен pd', async () => {
    const screen = await screens.guideBookingsScreen(SELLER.partnerId, 'max', NOW);
    expect(screen.pd).toBe(true);
    expect(screen.text).toContain(`${NAME}, ${PHONE}`);
    expect(screen.text).not.toContain(EMAIL);
    expect(screen.text).not.toContain(WISH);
  });

  it('окно — ближайшие 14 дней: отменённая и декабрьская не показаны, «ждёт оплаты» подписана словами кабинета', async () => {
    const { text } = await screens.guideBookingsScreen(SELLER.partnerId, 'telegram', NOW);
    expect(text).toContain('Ближайшие 14 дней: 2.');
    expect(text).toContain('№502');
    expect(text).toContain('№503 · Пещеры &lt;Камчатки&gt; · 04.11 · 2 чел · Ждёт оплаты');
    expect(text).not.toContain('№504');
    expect(text).not.toContain('№505');
    // Ближайшая — первой.
    expect(text.indexOf('№502')).toBeLessThan(text.indexOf('№503'));
  });

  it('броней нет — так и сказано, и в MAX экран без ПД обычным ответом', async () => {
    m.bookings.mockResolvedValue([]);
    const screen = await screens.guideBookingsScreen(SELLER.partnerId, 'max', NOW);
    expect(screen.pd).toBe(false);
    expect(screen.text).toContain('Ждут вашего ответа: нет.');
    expect(screen.text).toContain('Ближайшие 14 дней: броней нет.');
  });

  it('база не ответила — «не прочитались», а не «броней нет»; SQLSTATE в лог', async () => {
    m.bookings.mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' }));
    const screen = await screens.guideBookingsScreen(SELLER.partnerId, 'max', NOW);
    expect(screen.pd).toBe(false);
    expect(screen.text).toContain(screens.GUIDE_BOOKINGS_UNREAD);
    // Пустого списка нет: ни «ждут: нет», ни «броней нет» как ответа.
    expect(screen.text).not.toMatch(/Ждут вашего ответа|Ближайшие 14 дней/);
    expect(JSON.stringify(errorLog.mock.calls)).toContain('08006');
  });
});

describe('экран «Мои туры» гида', () => {
  it('на витрине — с открытыми датами; черновик и скрытый — словами кабинета, без дат', async () => {
    const text = screens.guideToursText([
      tour({}),
      tour({ id: '78', title: 'Черновик гида', is_published: false, open_dates: 0 }),
      tour({ id: '79', title: 'Выключенный тур', is_active: false, open_dates: 3 }),
    ]);
    expect(text).toContain('Пещеры &lt;Камчатки&gt; — На витрине · открытых дат: 4');
    expect(text).toContain('Черновик гида — Черновик — туристы не видят');
    expect(text).toContain('Выключенный тур — Скрыт');
    expect(text).not.toContain('Выключенный тур — Скрыт · открытых дат');
    expect(text).toContain('пришлите описание менеджеру Ведара');
    expect(text).toContain('/hub/guide/own');
  });

  it('туров нет — так и сказано; отказ базы — «не прочитались»', async () => {
    expect(screens.guideToursText([])).toContain('Своих туров в кабинете нет');
    m.tours.mockRejectedValue(new Error('timeout'));
    const text = await screens.guideToursScreen(SELLER.partnerId);
    expect(text).toContain(screens.GUIDE_TOURS_UNREAD);
    expect(text).not.toContain('Своих туров в кабинете нет');
  });
});

describe('кнопка меню → экран', () => {
  it('гид команды оператора без своих туров: «Брони» и «Мои туры» не выполняются, брони не читаются', async () => {
    for (const action of ['bookings', 'tours'] as const) {
      const screen = await roleMenuScreen({ role: 'guide', action, channel: 'max', partner: TEAM_GUIDE, nowMs: NOW });
      expect(screen).toEqual({ text: GUIDE_NO_OWN_TOURS, pd: false });
    }
    expect(m.bookings).not.toHaveBeenCalled();
    expect(m.tours).not.toHaveBeenCalled();
  });

  it('канал telegram — экран без ПД; канал max — с ПД', async () => {
    const tg = await roleMenuScreen({ role: 'guide', action: 'bookings', channel: 'telegram', partner: SELLER, nowMs: NOW });
    expect(tg.pd).toBe(false);
    noPd(tg.text);
    const mx = await roleMenuScreen({ role: 'guide', action: 'bookings', channel: 'max', partner: SELLER, nowMs: NOW });
    expect(mx.pd).toBe(true);
    expect(mx.text).toContain(PHONE);
  });

  it('команды чата Telegram — из строки меню: у продавца четыре, у гида команды две, сводки командой нет', () => {
    const seller = roleChatCommands(partnerMenu(SELLER) ?? []);
    expect(seller).toEqual([
      { command: 'requests', description: 'Входящие' },
      { command: 'bookings', description: 'Брони' },
      { command: 'tours', description: 'Мои туры' },
      { command: 'help', description: 'Помощь' },
    ]);
    expect(roleChatCommands(partnerMenu(TEAM_GUIDE) ?? []).map((c) => c.command)).toEqual(['requests', 'help']);
    expect(roleChatCommands([{ text: 'Сводка', payload: 'rm:op:sm' }])).toEqual([]);
  });
});

// ── MAX: живой вход ─────────────────────────────────────────────────────────

const KEY = 'test-webhook-key-29-10';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const UNVERIFIED = 'http://localhost/api/max/kuzmich';
const GUIDE_USER = 601;
const GUIDE_CHAT = 9_601;

const postMax = (url: string, body: unknown) =>
  max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

const tap = (payload: string, chatType = 'dialog') => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: 'cb-gd', payload, user: { user_id: GUIDE_USER, name: 'Гид' } },
  message: { recipient: { chat_id: GUIDE_CHAT, chat_type: chatType }, body: { mid: 'm-gd', seq: 1, text: 'меню' } },
});

const said = (text: string, chatType = 'dialog') => ({
  update_type: 'message_created',
  timestamp: 1,
  message: {
    sender: { user_id: GUIDE_USER, name: 'Гид' },
    recipient: { chat_id: GUIDE_CHAT, chat_type: chatType },
    body: { mid: `m-${text}-${chatType}`, seq: 1, text, attachments: [] },
  },
});

const maxTexts = () => m.maxSend.mock.calls.filter((c) => c[0] === GUIDE_CHAT).map((c) => String(c[1]));
const maxButtons = () => JSON.stringify(m.maxSend.mock.calls.filter((c) => c[0] === GUIDE_CHAT).map((c) => c[2] ?? null));

describe('MAX: «Брони» гида', () => {
  it('кнопка в личном диалоге — ПД только через sendPdAlert в этот чат, без заглушки в Telegram', async () => {
    await postMax(VERIFIED, tap('rm:gd:bk'));
    expect(m.findPartner).toHaveBeenCalledWith('max', GUIDE_CHAT);
    expect(m.pdAlert).toHaveBeenCalledTimes(1);
    const alert = m.pdAlert.mock.calls[0][0] as { text: string; stub: string; to: unknown; buttons: Array<{ payload?: string }> };
    expect(alert.to).toEqual({ maxChatId: GUIDE_CHAT, telegramChatId: null });
    expect(alert.text).toContain(PHONE);
    noPd(alert.stub);
    // Кнопки ответа ждущей брони (шаг 6: вопрос, затем «Да») — над строкой меню.
    expect(alert.buttons.map((b) => b.payload)).toEqual(['bk:c:501', 'bk:x:501', 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
    // Обычным сообщением ПД не уходят.
    for (const t of maxTexts()) noPd(t);
  });

  it('ПД не доставлены — строка без ПД в тот же чат', async () => {
    m.pdAlert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'MAX отказал' });
    await postMax(VERIFIED, tap('rm:gd:bk'));
    expect(maxTexts()).toEqual([PARTNER_PD_UNDELIVERED]);
  });

  it('группа и незаверенный апдейт — отказ до чтения броней', async () => {
    await postMax(VERIFIED, tap('rm:gd:bk', 'chat'));
    expect(maxTexts()).toEqual(['Кнопки кабинета работают в личном диалоге.']);
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    await postMax(UNVERIFIED, tap('rm:gd:bk'));
    expect(m.bookings).not.toHaveBeenCalled();
    expect(m.pdAlert).not.toHaveBeenCalled();
  });

  it('гид команды без своих туров — устаревшая кнопка не читает броней', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: TEAM_GUIDE });
    await postMax(VERIFIED, tap('rm:gd:bk'));
    expect(m.bookings).not.toHaveBeenCalled();
    expect(m.pdAlert).not.toHaveBeenCalled();
    expect(maxTexts()).toEqual([GUIDE_NO_OWN_TOURS]);
    expect(maxButtons()).not.toContain('rm:gd:bk');
  });

  it('«Мои туры» — обычным ответом со строкой меню, без sendPdAlert', async () => {
    await postMax(VERIFIED, tap('rm:gd:tr'));
    expect(m.tours).toHaveBeenCalledWith(SELLER.partnerId);
    expect(m.pdAlert).not.toHaveBeenCalled();
    expect(maxTexts()[0]).toContain('<b>Мои туры</b>');
    expect(maxButtons()).toContain('rm:gd:tr');
  });

  it('команда /bookings: в диалоге — через sendPdAlert; в группе — отказ без чтения', async () => {
    await postMax(VERIFIED, said('/bookings'));
    expect(m.pdAlert).toHaveBeenCalledTimes(1);
    expect((m.pdAlert.mock.calls[0][0] as { to: unknown }).to).toEqual({ maxChatId: GUIDE_CHAT, telegramChatId: null });
    m.pdAlert.mockClear();
    m.bookings.mockClear();
    m.maxSend.mockClear();
    await postMax(VERIFIED, said('/bookings', 'chat'));
    expect(m.bookings).not.toHaveBeenCalled();
    expect(m.pdAlert).not.toHaveBeenCalled();
    expect(maxTexts().join('\n')).toContain('только в личном диалоге');
    for (const t of maxTexts()) noPd(t);
  });

  it('привязка гида по ссылке: под ответом его строка меню, продавцу — с «Бронями» и «Моими турами»', async () => {
    const token = createPartnerLinkToken(SELLER.partnerId, Date.now());
    if (!token.ok) throw new Error('нет токена');
    for (const [sells, expected] of [
      [true, ['rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']],
      [false, ['rm:gd:in', 'rm:gd:hp']],
    ] as const) {
      m.maxSend.mockClear();
      clearMaxMessageDedup();
      m.pool.mockImplementation(async (sql: string) => (
        /UPDATE partners p/.test(sql)
          ? { rows: [{ name: 'Гид', display_name: 'Гид', category: 'guide', slug: 'guide-seller', previous: null, sells_tours: sells }] }
          : /FROM partners/.test(sql) ? { rows: [{ id: SELLER.partnerId, name: 'Гид' }] } : { rows: [] }
      ));
      await postMax(VERIFIED, {
        update_type: 'bot_started', timestamp: 1, chat_id: GUIDE_CHAT, payload: `op_${token.token}`,
        user: { user_id: GUIDE_USER, name: 'Гид' },
      });
      const call = m.maxSend.mock.calls.find((c) => c[0] === GUIDE_CHAT);
      expect(String(call?.[1])).toContain('Вы подключены как гид');
      const payloads = (call?.[2] as { attachments: Array<{ payload: { buttons: Array<Array<{ payload: string }>> } }> })
        .attachments[0].payload.buttons.flat().map((b) => b.payload);
      expect(payloads, `sellsTours=${sells}`).toEqual(expected);
    }
  });
});

// ── Telegram: живой вход ────────────────────────────────────────────────────

const TG_CHAT = 7_601;
let updateId = 29_100;

const postTg = (body: Record<string, unknown>) => telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
  method: 'POST',
  body: JSON.stringify({ update_id: updateId++, ...body }),
}));

const tgTap = (data: string, type = 'private') => postTg({
  callback_query: { id: `cb-${updateId}`, from: { id: TG_CHAT }, message: { chat: { id: TG_CHAT, type } }, data },
});

const tgSay = (text: string) => postTg({
  message: { message_id: 1, from: { id: TG_CHAT, first_name: 'Гид' }, chat: { id: TG_CHAT, type: 'private' }, text },
});

type TgMessage = { chatId: string; text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
const tgSent = () => m.tgSend.mock.calls.map((c) => c[0] as TgMessage).filter((x) => x.chatId === String(TG_CHAT));

describe('Telegram: «Брони» гида', () => {
  it('кнопка в личном чате — текст без ПД, sendPdAlert не зовётся', async () => {
    await tgTap('rm:gd:bk');
    expect(m.findPartner).toHaveBeenCalledWith('telegram', TG_CHAT);
    expect(m.bookings).toHaveBeenCalledWith(SELLER.partnerId);
    expect(m.pdAlert).not.toHaveBeenCalled();
    const [reply] = tgSent();
    expect(reply.text).toContain('№501');
    expect(reply.text).toContain('Имя и телефон туриста — в MAX и в кабинете.');
    noPd(reply.text);
  });

  it('кнопка в группе — «в личном диалоге», брони не читаются', async () => {
    await tgTap('rm:gd:bk', 'group');
    expect(m.bookings).not.toHaveBeenCalled();
    expect(tgSent().map((x) => x.text)).toEqual(['Кнопки кабинета работают в личном диалоге.']);
  });

  it('команда /bookings — тот же экран без ПД; «Мои туры» — кнопкой', async () => {
    await tgSay('/bookings');
    const [reply] = tgSent();
    expect(reply.text).toContain('<b>Брони</b>');
    noPd(reply.text);
    m.tgSend.mockClear();
    await tgTap('rm:gd:tr');
    expect(tgSent()[0].text).toContain('<b>Мои туры</b>');
  });

  it('«Старт» в уже привязанном чате гида — справка со строкой меню и команды чата из неё', async () => {
    await tgSay('/start');
    const [help] = tgSent();
    expect(help.text).toContain('Кабинет гида. Под ответом кнопки: Входящие, Брони, Мои туры, Помощь.');
    expect(help.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data))
      .toEqual(['rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
    const commands = vi.mocked(globalThis.fetch).mock.calls.find((c) => String(c[0]).endsWith('/setMyCommands'));
    const body = JSON.parse(String((commands?.[1] as RequestInit | undefined)?.body ?? '{}')) as { commands?: Array<{ command: string }> };
    expect(body.commands?.map((c) => c.command)).toEqual(['requests', 'bookings', 'tours', 'help']);
  });

  it('привязка гида по ссылке: строка меню под ответом и команды чата из неё же', async () => {
    const token = createPartnerLinkToken(SELLER.partnerId, Date.now());
    if (!token.ok) throw new Error('нет токена');
    m.pool.mockImplementation(async (sql: string) => (
      /UPDATE partners p/.test(sql)
        ? { rows: [{ name: 'Гид', display_name: 'Гид', category: 'guide', slug: 'guide-seller', previous: null, sells_tours: true }] }
        : /FROM partners/.test(sql) ? { rows: [{ id: SELLER.partnerId, name: 'Гид' }] } : { rows: [] }
    ));
    await tgSay(`/start op_${token.token}`);
    const bound = tgSent().find((x) => x.text.includes('Вы подключены как гид'));
    expect(bound?.text).toContain('«Брони»');
    noPd(bound?.text ?? '');
    expect(bound?.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data))
      .toEqual(['rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
    const fetchMock = vi.mocked(globalThis.fetch);
    const commands = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/setMyCommands'));
    expect(commands).toBeTruthy();
    const body = JSON.parse(String((commands?.[1] as RequestInit).body)) as { commands: Array<{ command: string }>; scope: unknown };
    expect(body.commands.map((c) => c.command)).toEqual(['requests', 'bookings', 'tours', 'help']);
    expect(body.scope).toEqual({ type: 'chat', chat_id: TG_CHAT });
  });
});
