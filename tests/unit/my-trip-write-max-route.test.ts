/**
 * tests/unit/my-trip-write-max-route.test.ts
 *
 * «Написать оператору» под «Моей поездкой» — живым вебхуком MAX (#2970,
 * шаг 3): фраза и кнопка меню отвечают списком С кнопками; нажатие кнопки
 * доходит до проверки права (lib/requests/my-trip-write) только из личного
 * диалога и по заверенному апдейту. Подменены база, модель, транспорт MAX,
 * сборка списка и само нажатие: судится проводка вебхука, а не SQL (он — в
 * tests/integration/request-chat.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  fallback: vi.fn(),
  orNull: vi.fn(),
  maxSend: vi.fn(),
  findAdmin: vi.fn(),
  myTrip: vi.fn(),
  press: vi.fn(),
  datePress: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => m.pool(...a),
    connect: async () => ({ query: (...a: unknown[]) => m.pool(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => m.fallback(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => m.orNull(...a),
  callAIFast: vi.fn().mockResolvedValue('нет'),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/route-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/route-knowledge')>()),
  searchRoutes: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telegram/operator-availability')>()),
  searchOperatorAvailability: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/planner/interests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner/interests')>()),
  findRoutesByInterests: vi.fn().mockResolvedValue([]),
}));
// Контроль выхода — не предмет этого сторожа.
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: vi.fn(async () => ({ success: true })) },
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn().mockResolvedValue({ delivered: true }) }));
vi.mock('@/lib/leads/create', () => ({ createLead: vi.fn().mockResolvedValue('lead-1') }));
vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: (...a: unknown[]) => m.maxSend(...a),
      sendMessageToUser: vi.fn().mockResolvedValue({}),
      answerOnCallback: vi.fn().mockResolvedValue({}),
      editMessage: vi.fn().mockResolvedValue({ success: true }),
    },
  }),
  maxFetch: vi.fn(),
}));
vi.mock('@/lib/max/admin-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: (...a: unknown[]) => m.findAdmin(...a),
}));

vi.mock('@/lib/requests/my-trip', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/my-trip')>()),
  myTripMessage: (...a: unknown[]) => m.myTrip(...a),
}));
vi.mock('@/lib/requests/my-trip-write', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/my-trip-write')>()),
  pressMyTripWrite: (...a: unknown[]) => m.press(...a),
}));
vi.mock('@/lib/requests/my-trip-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/my-trip-date')>()),
  pressMyTripDate: (...a: unknown[]) => m.datePress(...a),
}));

const max = await import('@/app/api/max/kuzmich/route');
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');
const { signPayload } = await import('@/lib/chat-cabinet/signed-payload');
const { myTripWritePayload } = await import('@/lib/requests/my-trip-write');
const { myTripDateMenuPayload, myTripDatePickPayload } = await import('@/lib/requests/my-trip-date');

const KEY = 'test-webhook-key-my-trip-write';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const CHAT = 9_411;
const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const RAW = myTripWritePayload({ kind: 'lead', id: LEAD });
let seq = 0;

const post = (body: unknown, url = VERIFIED) => max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

const say = (text: string) => post({
  update_type: 'message_created',
  timestamp: Date.now(),
  message: {
    sender: { user_id: CHAT, name: 'Анна' },
    recipient: { chat_id: CHAT, chat_type: 'dialog' },
    body: { mid: `mid-mtw-${++seq}`, seq: 1, text },
  },
});

const press = (payload: string, chatType: 'dialog' | 'chat' = 'dialog', url = VERIFIED) => post({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: `cb-mtw-${++seq}`, payload, user: { user_id: CHAT, name: 'Анна' } },
  message: { recipient: { chat_id: CHAT, chat_type: chatType }, body: { mid: `m-mtw-${seq}`, seq: 1, text: 'Моя поездка' } },
}, url);

/** Что ушло в чат: текст и всё, что приложено (кнопки). */
const sent = () => m.maxSend.mock.calls.filter((c) => c[0] === CHAT).map((c) => ({ text: String(c[1]), extra: JSON.stringify(c[2] ?? {}) }));

beforeEach(() => {
  clearMaxMessageDedup();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'route-signing');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.maxSend.mockResolvedValue({});
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.db.mockResolvedValue({ rows: [] });
  m.pool.mockResolvedValue({ rows: [] });
  m.tools.mockResolvedValue({ content: 'ОТВЕТ МОДЕЛИ', tool_calls: null, provider: 'test' });
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
  m.orNull.mockResolvedValue('ОТВЕТ БЕЗ ИНСТРУМЕНТОВ');
  m.myTrip.mockResolvedValue({ text: 'Ваша заявка в этом чате:\n\n1. Горелый', buttons: [{ text: 'Написать оператору', payload: signPayload(RAW) }] });
  m.press.mockResolvedValue({ text: 'Напишите одним сообщением — оно уйдёт оператору.', buttons: [] });
  m.datePress.mockResolvedValue({ text: 'Свободные даты на 2 чел.:', buttons: [{ text: '18.07 · мест 5', payload: 'mp:x' }] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('«Моя поездка» в MAX — с кнопкой «Написать оператору»', () => {
  it('фраза «моя поездка»: список с кнопкой, модель не зовётся', async () => {
    await say('моя поездка');
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('Ваша заявка в этом чате');
    expect(out[0]!.extra).toContain('Написать оператору');
    expect(out[0]!.extra).toContain(RAW);
    expect(m.myTrip).toHaveBeenCalledWith('max', CHAT);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('кнопка меню «Моя поездка»: тот же список с кнопкой', async () => {
    await press('my_trip');
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]!.extra).toContain(RAW);
  });

  it('нажатие «Написать оператору» в личном диалоге — проверка права с этим чатом, ответ в чат', async () => {
    await press(signPayload(RAW));
    expect(m.press).toHaveBeenCalledWith(RAW, CHAT);
    expect(sent().map((s) => s.text)).toEqual(['Напишите одним сообщением — оно уйдёт оператору.']);
  });

  it('из группы — не применяется: переписка только в личном диалоге', async () => {
    await press(signPayload(RAW), 'chat');
    expect(m.press).not.toHaveBeenCalled();
    expect(sent().map((s) => s.text).join('\n')).toMatch(/личном диалоге/);
  });

  it('без заверения апдейта — нажатие не доходит до проверки права', async () => {
    await press(signPayload(RAW), 'dialog', 'http://localhost/api/max/kuzmich');
    expect(m.press).not.toHaveBeenCalled();
  });
});

describe('«Изменить дату» под «Моей поездкой» в MAX (#2970, шаг 3)', () => {
  const MENU = myTripDateMenuPayload(LEAD);
  const PICK = myTripDatePickPayload(LEAD, '2027-07-18');

  it('«Изменить дату» в личном диалоге — даты кнопками, канал и чат этого апдейта', async () => {
    await press(MENU);
    expect(m.datePress).toHaveBeenCalledWith(MENU, 'max', CHAT);
    const out = sent();
    expect(out.map((s) => s.text)).toEqual(['Свободные даты на 2 чел.:']);
    expect(out[0]!.extra).toContain('18.07 · мест 5');
  });

  it('выбор даты — подписанная кнопка доходит без подписи до смены даты', async () => {
    await press(signPayload(PICK));
    expect(m.datePress).toHaveBeenCalledWith(PICK, 'max', CHAT);
  });

  it('выбор даты без подписи после срока старых кнопок — не принят: это кнопка-запись', async () => {
    // Тестовая обвязка (test/setup.ts) продлевает приём неподписанных кнопок; здесь — боевой срок.
    vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', String(Date.parse('2026-11-05T12:00:00Z')));
    await press(PICK);
    expect(m.datePress).not.toHaveBeenCalled();
    expect(sent().map((s) => s.text).join('\n')).not.toMatch(/Свободные даты/);
  });

  it('из группы и без заверения апдейта — дата не меняется', async () => {
    await press(signPayload(PICK), 'chat');
    expect(m.datePress).not.toHaveBeenCalled();
    expect(sent().map((s) => s.text).join('\n')).toMatch(/личном диалоге/);
    await press(signPayload(PICK), 'dialog', 'http://localhost/api/max/kuzmich');
    expect(m.datePress).not.toHaveBeenCalled();
  });
});
