/**
 * tests/unit/my-trip-date-telegram.test.ts
 *
 * «Изменить дату» под «Моей поездкой» — живым вебхуком Telegram (#2970,
 * шаг 3). Переписка клиента живёт в MAX, а дату заявки турист меняет и из
 * Telegram: список отвечает инлайн-кнопками под сообщением, нажатие доходит
 * до смены даты только из личного чата и с подписью кнопки-записи.
 * Подменены база, транспорт Telegram, сборка списка и само нажатие: судится
 * проводка вебхука, а не SQL (он — в tests/integration/request-chat.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  tgSend: vi.fn(),
  myTrip: vi.fn(),
  datePress: vi.fn(),
  processMessage: vi.fn(),
  findPartner: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: async () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('@/lib/kuzmich/core', () => ({ hasLiveBookingFlow: vi.fn(async () => false), processMessage: m.processMessage, cleanupPending: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/operator-chat')>()),
  findPartnerByChat: m.findPartner,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'test_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/requests/chat-links', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/chat-links')>()),
  chatHasRequests: vi.fn(async () => true),
}));
vi.mock('@/lib/requests/my-trip', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/my-trip')>()),
  myTripMessage: (...a: unknown[]) => m.myTrip(...a),
}));
vi.mock('@/lib/requests/my-trip-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/my-trip-date')>()),
  pressMyTripDate: (...a: unknown[]) => m.datePress(...a),
}));

const telegram = await import('@/app/api/telegram/webhook/route');
const { signPayload } = await import('@/lib/chat-cabinet/signed-payload');
const { myTripDateMenuPayload, myTripDatePickPayload } = await import('@/lib/requests/my-trip-date');

const TG_CHAT = 7_970;
const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const MENU = myTripDateMenuPayload(LEAD);
const PICK = myTripDatePickPayload(LEAD, '2027-07-18');

let updateId = 97_000;
const post = (body: Record<string, unknown>) => telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
  method: 'POST',
  body: JSON.stringify({ update_id: updateId++, ...body }),
}));
const say = (text: string) => post({
  message: { message_id: updateId, date: 1, from: { id: TG_CHAT, first_name: 'Анна' }, chat: { id: TG_CHAT, type: 'private' }, text },
});
const tap = (data: string, type = 'private') => post({
  callback_query: { id: `cb-${updateId}`, from: { id: TG_CHAT }, message: { chat: { id: TG_CHAT, type } }, data },
});

type TgMessage = { chatId: string; text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>>; keyboard?: unknown } };
const sent = () => m.tgSend.mock.calls.map((c) => c[0] as TgMessage).filter((x) => String(x.chatId) === String(TG_CHAT));
const inline = (msg: TgMessage | undefined) => (msg?.replyMarkup?.inline_keyboard ?? []).flat();

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.tgSend.mockResolvedValue({ success: true });
  m.findPartner.mockResolvedValue({ outcome: 'none' });
  m.processMessage.mockResolvedValue(undefined);
  m.myTrip.mockResolvedValue({ text: 'Ваша заявка в этом чате:\n\n1. Горелый & кратер', buttons: [{ text: 'Изменить дату', payload: MENU }] });
  m.datePress.mockResolvedValue({ text: 'Свободные даты на 2 чел.:', buttons: [{ text: '18.07 · мест 5', payload: signPayload(PICK) }] });
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tg-test-token');
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'tg-signing');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('«Моя поездка» в Telegram — с «Изменить дату»', () => {
  it('фраза: список с инлайн-кнопкой, текст экранирован, модель не зовётся', async () => {
    await say('Моя поездка');
    expect(m.myTrip).toHaveBeenCalledWith('telegram', String(TG_CHAT));
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('Горелый &amp; кратер');
    expect(inline(out[0])).toEqual([{ text: 'Изменить дату', callback_data: MENU }]);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('кнопок нет — прежний ответ с постоянной клавиатурой туриста', async () => {
    m.myTrip.mockResolvedValue({ text: 'В этом чате заявок пока нет.', buttons: [] });
    await say('Моя поездка');
    const out = sent();
    expect(out).toHaveLength(1);
    expect(inline(out[0])).toEqual([]);
    expect(out[0]!.replyMarkup?.keyboard).toBeDefined();
  });
});

describe('нажатия «Изменить дату» в Telegram', () => {
  it('«Изменить дату» в личном чате — даты кнопками, канал и чат этого нажатия', async () => {
    await tap(MENU);
    expect(m.datePress).toHaveBeenCalledWith(MENU, 'telegram', TG_CHAT);
    const out = sent();
    expect(out.map((x) => x.text)).toEqual(['Свободные даты на 2 чел.:']);
    expect(inline(out[0]).map((b) => b.text)).toEqual(['18.07 · мест 5']);
  });

  it('выбор даты: подписанная кнопка доходит без подписи', async () => {
    await tap(signPayload(PICK));
    expect(m.datePress).toHaveBeenCalledWith(PICK, 'telegram', TG_CHAT);
  });

  it('выбор даты без подписи после срока старых кнопок — не принят', async () => {
    vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', String(Date.parse('2026-11-05T12:00:00Z')));
    await tap(PICK);
    expect(m.datePress).not.toHaveBeenCalled();
  });

  it('из группы — ничего не меняется, сказано, где меняют', async () => {
    await tap(signPayload(PICK), 'group');
    expect(m.datePress).not.toHaveBeenCalled();
    expect(sent().map((x) => x.text).join('\n')).toMatch(/в личном диалоге с ботом/);
  });
});
