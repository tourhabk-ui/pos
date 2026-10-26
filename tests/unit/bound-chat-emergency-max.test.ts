/**
 * Беда из привязанного чата MAX получает блок 112 (проверка качества 24.10).
 *
 * До правки «помогите, мы заблудились» от гида или прокатчика в его чате
 * уходило помощнику CRM — у того блока 112 не было, — а администратору бот
 * отвечал «Не понял команду». Телефон туриста из реплики партнёра («запиши
 * звонок: Анна +7 …») уходил в зарубежную модель и в историю переписки как
 * есть.
 *
 * Сторож — вызов заверенного вебхука POST /api/max/kuzmich?s=<ключ> с
 * настоящим классификатором (lib/kuzmich/bound-chat-route), настоящим мозгом
 * Кузьмича туриста (lib/kuzmich/core), настоящим помощником кабинета
 * (lib/kuzmich/operator-chat) и настоящим ответом администратора
 * (lib/max/admin-chat). Подменены модель, база, транспорт MAX и проверка
 * «администратор ли это». Судится то, что получает человек (строка
 * «Звоните 112», чей ответ), и то, что видят модель и tg_conversations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { clearBoundChatEmergencies } from '@/lib/kuzmich/bound-chat-route';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  fallback: vi.fn(),
  orNull: vi.fn(),
  direct: vi.fn(),
  maxSend: vi.fn(),
  findAdmin: vi.fn(),
  /** Строки tg_conversations по возрастанию времени. */
  history: [] as Array<{ chatId: number; mode: string; role: string; content: string }>,
  /** Строка partners для привязанного чата; null — чат не привязан. */
  partnerRow: null as null | Record<string, unknown>,
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
  callAIWithModelDirect: (...a: unknown[]) => m.direct(...a),
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

const max = await import('@/app/api/max/kuzmich/route');
// Тесты шлют одни и те же mid: повтор сообщения отсекается (25.10), память — заново на тест.
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');
const { ADMIN_CHAT_TEXT } = await import('@/lib/max/admin-chat');

const KEY = 'test-webhook-key-24-10-sos';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const CHAT = 8_824;
const SOS_LINE = 'Звоните 112';
const CABINET_ANSWER = 'ОТВЕТ ПОМОЩНИКА КАБИНЕТА';
// Без «тур» и «маршрут»: иначе вебхук добавит вторым сообщением «Хотите
// оформить заявку?» (hasTourRecommendation), и считать пришлось бы его.
const TOURIST_ANSWER = 'ОТВЕТ МОЗГА КУЗЬМИЧА';
// Номер выдуманный; в цифрах без разделителей — 79000000000.
const PHONE = '+7 900 000-00-00';
const PHONE_DIGITS = '9000000000';

const GUIDE = {
  id: '11111111-1111-4111-8111-111111111111', slug: null, name: 'Вулкан-Тур',
  category: 'guide', user_id: 'u-guide', profile_status: 'approved',
};
const LAGUNA = {
  id: '22222222-2222-4222-8222-222222222222', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  category: 'transfer', user_id: null, profile_status: null,
};

const post = (body: unknown) => max.POST(new NextRequest(VERIFIED, { method: 'POST', body: JSON.stringify(body) }));

function message(text: string) {
  return {
    update_type: 'message_created',
    timestamp: Date.now(),
    message: {
      sender: { user_id: CHAT, name: 'Анна' },
      recipient: { chat_id: CHAT, chat_type: 'dialog' },
      body: { mid: 'mid-sos', seq: 1, text },
    },
  };
}

/** Тексты, ушедшие в чат. */
function replies(): string[] {
  return m.maxSend.mock.calls.filter((c) => c[0] === CHAT).map((c) => String(c[1]));
}

type ModelMsg = { role: string; content: string | null };

/** Всё, что ушло в модели: цикл инструментов, оба водопада, одиночный вызов. */
function modelInput(): string {
  const msgs = [
    ...m.tools.mock.calls.map((c) => c[0]),
    ...m.fallback.mock.calls.map((c) => c[0]),
    ...m.orNull.mock.calls.map((c) => c[0]),
    ...m.direct.mock.calls.map((c) => c[0]),
  ] as ModelMsg[][];
  return msgs.flat().map((x) => x.content ?? '').join('\n');
}

/** Имена инструментов, которые получила модель. */
function toolNames(): string[] {
  return m.tools.mock.calls
    .flatMap((c) => (c[1] ?? []) as Array<{ function?: { name?: string } }>)
    .map((t) => String(t.function?.name));
}

/** Параметры каждого INSERT INTO tg_conversations. */
function savedRows(): unknown[][] {
  return m.pool.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO tg_conversations'))
    .map((c) => c[1] as unknown[]);
}

/** Номер без разделителей: «+7 900 000-00-00» → «79000000000». */
const digitsOnly = (s: string) => s.replace(/[\s()+-]/g, '');

beforeEach(() => {
  clearMaxMessageDedup();
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  m.history = [];
  m.partnerRow = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  // Наружу из теста ничего не ходит.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.maxSend.mockResolvedValue({});
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.db.mockResolvedValue({ rows: [] });
  m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('INSERT INTO tg_conversations')) {
      m.history.push({
        chatId: Number(params?.[0]), mode: String(params?.[1] ?? ''),
        role: String(params?.[2] ?? ''), content: String(params?.[3] ?? ''),
      });
      return { rows: [] };
    }
    if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
      // Запрос истории — по убыванию времени, код разворачивает сам.
      const [chatId, mode] = (params ?? []) as [number, string];
      return {
        rows: m.history
          .filter((r) => r.chatId === Number(chatId) && r.mode === mode)
          .map(({ role, content }) => ({ role, content }))
          .reverse(),
      };
    }
    if (q.includes('FROM partners') && q.includes('max_chat_id')) {
      return { rows: m.partnerRow ? [m.partnerRow] : [] };
    }
    return { rows: [] };
  });
  // Помощник кабинета получает только инструменты crm_* (и прайс проката),
  // Кузьмич туриста — свои; по ним видно, чей это ответ.
  m.tools.mockImplementation(async (_msgs: unknown, tools?: Array<{ function?: { name?: string } }>) => {
    const crm = (tools ?? []).some((t) => String(t.function?.name).startsWith('crm_'));
    return { content: crm ? CABINET_ANSWER : TOURIST_ANSWER, tool_calls: null, provider: 'test' };
  });
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
  m.orNull.mockResolvedValue('ОТВЕТ ПОМОЩНИКА БЕЗ ИНСТРУМЕНТОВ');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('беда в привязанном чате партнёра (MAX)', () => {
  it.each([
    ['гид', GUIDE],
    ['пилот проката «Лагуна»', LAGUNA],
  ])('%s: «Помогите, мы заблудились» — ответ Кузьмича туриста с блоком 112', async (_who, row) => {
    m.partnerRow = row;
    await post(message('Помогите, мы заблудились'));

    // Отвечал мозг туриста: инструментов CRM у модели не было, переписка —
    // под режимом max, а не под режимом помощника кабинета.
    expect(m.tools).toHaveBeenCalled();
    expect(toolNames().some((n) => n.startsWith('crm_'))).toBe(false);
    expect(savedRows().map((p) => p[1])).not.toContain('operator_tg');

    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    expect(out[0]).toContain(TOURIST_ANSWER);
    expect(out[0]).not.toContain(CABINET_ANSWER);
  });

  it('беда с делом CRM («Запиши: турист сломал ногу …») — помощник кабинета, и его ответ несёт блок 112', async () => {
    m.partnerRow = GUIDE;
    await post(message('Запиши: турист сломал ногу на Горелом'));

    expect(toolNames().some((n) => n.startsWith('crm_'))).toBe(true);
    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CABINET_ANSWER);
    expect(out[0]).toContain(SOS_LINE);
  });

  it('обычное дело CRM — ответ кабинета без блока 112', async () => {
    m.partnerRow = GUIDE;
    await post(message('Запиши, что звонил'));
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain(CABINET_ANSWER);
    expect(replies()[0]).not.toContain('112');
  });
});

describe('беда в чате администратора (MAX)', () => {
  beforeEach(() => {
    m.findAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Анна' });
  });

  it('«Помогите, мы заблудились» — блок 112 от Кузьмича туриста, не «Не понял команду»', async () => {
    await post(message('Помогите, мы заблудились'));

    expect(m.findAdmin).toHaveBeenCalledWith(CHAT);
    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    expect(out[0]).toContain(TOURIST_ANSWER);
    expect(out.join('\n')).not.toContain('Не понял команду');
  });

  it('беда со словом CRM («запиши: турист сломал ногу») у администратора — тоже Кузьмичу туриста с 112: CRM у него нет', async () => {
    await post(message('запиши: турист сломал ногу'));

    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    expect(out[0]).toContain(TOURIST_ANSWER);
    expect(out.join('\n')).not.toContain('Не понял команду');
  });

  it('непонятая команда без беды — подсказка без блока 112', async () => {
    await post(message('как дела у вулкана'));
    expect(replies()).toEqual([ADMIN_CHAT_TEXT.notUnderstood]);
  });
});

describe('телефон из реплики партнёра (MAX)', () => {
  const ASK = `Запиши звонок: Анна ${PHONE} просила перенести тур`;

  it.each([
    ['цикл инструментов', false],
    ['водопад без инструментов (цикл не ответил)', true],
  ])('%s: номер не доходит до модели и не пишется в tg_conversations', async (_path, toolsSilent) => {
    m.partnerRow = GUIDE;
    if (toolsSilent) m.tools.mockResolvedValue(null);
    await post(message(ASK));

    // Вход модели — тот, что ждали: помощник кабинета, реплика дошла.
    expect(m.tools).toHaveBeenCalled();
    if (toolsSilent) expect(m.orNull).toHaveBeenCalled();
    const seen = modelInput();
    expect(seen).toContain('просила перенести тур');
    expect(seen).toContain('[телефон …0000]');
    expect(digitsOnly(seen)).not.toContain(PHONE_DIGITS);

    const rows = savedRows();
    const userRow = rows.find((p) => p[1] === 'operator_tg' && p[2] === 'user');
    expect(userRow?.[3]).toContain('просила перенести тур');
    expect(userRow?.[3]).toContain('[телефон …0000]');
    for (const p of rows) expect(digitsOnly(p.map(String).join(' '))).not.toContain(PHONE_DIGITS);
  });

  it('номер в строке истории, записанной до очистки, до модели тоже не доходит', async () => {
    m.partnerRow = GUIDE;
    m.history = [
      { chatId: CHAT, mode: 'operator_tg', role: 'user', content: `Запиши звонок: Анна ${PHONE}` },
      { chatId: CHAT, mode: 'operator_tg', role: 'assistant', content: 'Записал касание.' },
    ];
    await post(message('кто ждёт ответа?'));

    const seen = modelInput();
    expect(seen).toContain('Запиши звонок: Анна');
    expect(seen).toContain('кто ждёт ответа?');
    expect(digitsOnly(seen)).not.toContain(PHONE_DIGITS);
  });
});
