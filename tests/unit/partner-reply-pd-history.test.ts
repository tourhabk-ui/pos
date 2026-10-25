/**
 * Телефон в репликах ПОМОЩНИКА кабинета (проверка качества 24.10).
 *
 * Ответ на правку описания повторяет текст прокатчика («Новое описание: …»),
 * и номер из него ложился в tg_conversations строкой роли assistant. История
 * — вход модели на следующем ходу, то есть номер уходил в зарубежную модель
 * со следующей репликой. Строки, записанные до очистки (до 25.10), тоже
 * читаются: очистка на входе модели обязана касаться всех ролей, а не только
 * реплик человека.
 *
 * Вызов живого входа POST /api/telegram/webhook с настоящими кабинетом
 * проката, правкой прайса (lib/rental/offer-edit-flow) и помощником партнёра
 * (lib/kuzmich/operator-chat); подменены база, модели и транспорт. Номер
 * выдуманный: +7 900 000-00-00.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { clearBoundChatEmergencies } from '@/lib/kuzmich/bound-chat-route';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  orNull: vi.fn(),
  fallback: vi.fn(),
  direct: vi.fn(),
  tgSend: vi.fn(),
  /** Строки tg_conversations — по возрастанию времени. */
  history: [] as Array<{ chat: unknown; mode: unknown; role: string; content: string }>,
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.pool(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => m.orNull(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => m.fallback(...a),
  callAIWithModelDirect: (...a: unknown[]) => m.direct(...a),
  callAIFast: vi.fn().mockResolvedValue('нет'),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn() },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'kuzmichai_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn().mockResolvedValue({ delivered: true }) }));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/agents/intent-classifier', () => ({ classifyIntentByKeywords: () => 'unknown' }));

const telegram = await import('@/app/api/telegram/webhook/route');

const PARTNER_CHAT = 5151;
const PHONE = '+7 900 000-00-00';
/** Цифры номера без кода страны и разделителей. */
const PHONE_DIGITS = '9000000000';
const LAGUNA = {
  id: '22222222-2222-4222-8222-222222222222', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  category: 'transfer', user_id: null, profile_status: null,
};
/** Машина из прайса «Лагуны»: правку описания код ищет точным названием. */
const JIMNY = {
  id: '44444444-4444-4444-8444-444444444444', title: 'Suzuki Jimny',
  price_rub_per_day: 8500, price_is_from: false, conditions: null,
};
const EDIT = `описание Suzuki Jimny: бронь по телефону ${PHONE}`;
/** Ответ на ту же правку, как его писал кабинет до 25.10, — с номером. */
const LEGACY_ANSWER = `Черновик записан: «Suzuki Jimny». Новое описание: бронь по телефону ${PHONE}`;

let nextUpdateId = 25_500;

function post(text: string): Promise<Response> {
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: {
        message_id: 1,
        from: { id: PARTNER_CHAT, first_name: 'Анна' },
        chat: { id: PARTNER_CHAT, type: 'private' },
        text,
      },
    }),
  }));
}

/** Есть ли где-то цифры выдуманного номера (пробелы и дефисы сняты). */
function carriesPhone(values: unknown[]): boolean {
  return values.some((v) => String(v ?? '').replace(/\D/g, '').includes(PHONE_DIGITS));
}

/** Параметры каждого INSERT INTO tg_conversations. */
function conversationInserts(): unknown[][] {
  return m.pool.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO tg_conversations'))
    .map((c) => c[1] as unknown[]);
}

/** Всё, что ушло в модели: цикл инструментов, водопады, одиночный вызов. */
function modelContents(): string[] {
  const lists = [
    ...m.tools.mock.calls.map((c) => c[0]),
    ...m.orNull.mock.calls.map((c) => c[0]),
    ...m.fallback.mock.calls.map((c) => c[0]),
    ...m.direct.mock.calls.map((c) => c[0]),
  ] as Array<Array<{ content?: string | null }>>;
  return lists.flat().map((x) => String(x.content ?? ''));
}

beforeEach(() => {
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  m.history = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('TELEGRAM_CHAT_ID', '777');
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('INSERT INTO tg_conversations')) {
      m.history.push({ chat: params?.[0], mode: params?.[1], role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
      return { rows: [] };
    }
    if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
      const own = m.history.filter((h) => h.chat === params?.[0] && h.mode === params?.[1]);
      return { rows: own.map(({ role, content }) => ({ role, content })).reverse() };
    }
    if (q.includes('FROM partners') && q.includes('telegram_chat_id = $1')) {
      return { rows: params?.[0] === PARTNER_CHAT ? [LAGUNA] : [] };
    }
    // Правка прайса: машина — точным названием, черновик — в rental_offer_edits.
    if (q.includes('FROM car_rental_offers') && q.includes('lower(btrim(title))')) {
      const asked = String(params?.[1] ?? '').trim().toLowerCase();
      return { rows: asked === JIMNY.title.toLowerCase() ? [JIMNY] : [] };
    }
    if (q.includes('INSERT INTO rental_offer_edits')) {
      return { rows: [{ price_rub_per_day: params?.[2] ?? null, conditions: params?.[3] ?? null }] };
    }
    return { rows: [] };
  });
  m.db.mockResolvedValue({ rows: [] });
  m.tgSend.mockResolvedValue({ success: true });
  m.tools.mockResolvedValue({ content: 'Ждут ответа двое.', tool_calls: null, provider: 'test' });
  m.orNull.mockResolvedValue('Запасной ответ кабинета');
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('правка описания с телефоном: ответ помощника в историю — без номера', () => {
  it(`«${EDIT}» — черновик записан, обе строки tg_conversations без цифр номера`, async () => {
    await post(EDIT);

    // Ответил код правки прайса, не модель: черновик записан.
    expect(m.pool.mock.calls.some((c) => String(c[0]).includes('INSERT INTO rental_offer_edits'))).toBe(true);
    expect(m.tools).not.toHaveBeenCalled();
    const out = m.tgSend.mock.calls.map((c) => String((c[0] as { text?: string }).text ?? ''));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Черновик записан');

    const rows = conversationInserts().filter((p) => p[1] === 'operator_tg');
    const assistant = rows.find((p) => p[2] === 'assistant');
    expect(assistant?.[3]).toContain('Черновик записан');
    expect(assistant?.[3]).toContain('Новое описание: бронь по телефону [телефон …0000]');
    expect(rows.some((p) => p[2] === 'user')).toBe(true);
    expect(carriesPhone(conversationInserts().flat())).toBe(false);
  });

  it('следующий ход после такой правки: в модель номер не уходит', async () => {
    await post(EDIT);
    await post('кто ждёт ответа?');

    expect(m.tools).toHaveBeenCalledTimes(1);
    const seen = modelContents();
    expect(seen.some((c) => c.includes('Черновик записан'))).toBe(true);
    expect(carriesPhone(seen)).toBe(false);
  });
});

describe('строка помощника, записанная до очистки (с номером), до модели не доходит с ним', () => {
  it.each([
    ['цикл инструментов', false],
    ['водопад без инструментов (цикл не ответил)', true],
  ])('%s: вход модели без цифр номера, сама реплика дошла', async (_path, toolsSilent) => {
    m.history = [
      { chat: PARTNER_CHAT, mode: 'operator_tg', role: 'user', content: 'описание Suzuki Jimny: бронь по телефону [телефон]' },
      { chat: PARTNER_CHAT, mode: 'operator_tg', role: 'assistant', content: LEGACY_ANSWER },
    ];
    if (toolsSilent) m.tools.mockResolvedValue(null);
    await post('кто ждёт ответа?');

    expect(m.tools).toHaveBeenCalledTimes(1);
    if (toolsSilent) expect(m.orNull).toHaveBeenCalledTimes(1);
    const toolsInput = (m.tools.mock.calls[0]?.[0] ?? []) as Array<{ role?: string; content?: string | null }>;
    const legacy = toolsInput.find((x) => x.role === 'assistant' && String(x.content ?? '').includes('Черновик записан'));
    expect(legacy?.content).toContain('бронь по телефону [телефон …0000]');
    expect(carriesPhone(modelContents())).toBe(false);
  });
});
