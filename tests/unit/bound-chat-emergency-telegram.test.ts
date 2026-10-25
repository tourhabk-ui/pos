/**
 * Беда в привязанном чате Telegram получает блок 112 (проверка качества 24.10).
 *
 * До правки «помогите, мы заблудились» от гида или оператора в его
 * привязанном чате забирал помощник кабинета CRM — без блока 112, — а
 * администратору кабинет отвечал «Не понял команду». И текст партнёра
 * («запиши звонок Анне +7 …») уходил в зарубежную модель и в историю
 * tg_conversations с телефоном.
 *
 * Сторож — вызов живого входа POST /api/telegram/webhook с настоящими
 * классификатором (bound-chat-route), меню роли, кабинетом проката, кабинетом
 * администратора, помощником партнёра (operator-chat) и мозгом Кузьмича
 * (core): подменены только база, модели и транспорт. Судится то, что получает
 * человек (строка «Звоните 112», кто ответил), что видит модель и что ложится
 * в историю.
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
  createLead: vi.fn(),
  createTicket: vi.fn(),
  openTickets: vi.fn(),
  addTicketMessage: vi.fn(),
  dispatch: vi.fn(),
  classify: vi.fn(),
  /** Строки tg_conversations — по возрастанию времени. */
  history: [] as Array<{ chat: unknown; mode: unknown; role: string; content: string }>,
  /** Строка partners по telegram_chat_id; null — чат не привязан. */
  partner: null as null | Record<string, unknown>,
  /** Привязка администратора по from.id (admin_tg_bindings); null — нет. */
  admin: null as null | { user_id: string; name: string },
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

// ── Транспорт и соседи роута ───────────────────────────────────────────────
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn() },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'kuzmichai_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn().mockResolvedValue({ delivered: true }) }));
vi.mock('@/lib/planner/interests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner/interests')>()),
  findRoutesByInterests: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/leads/create', () => ({ createLead: (...a: unknown[]) => m.createLead(...a) }));
vi.mock('@/lib/support/ticket.service', () => ({
  createTicket: (...a: unknown[]) => m.createTicket(...a),
  getUserOpenTickets: (...a: unknown[]) => m.openTickets(...a),
  addTicketMessage: (...a: unknown[]) => m.addTicketMessage(...a),
}));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: { dispatch: (...a: unknown[]) => m.dispatch(...a) } }));
vi.mock('@/lib/agents/intent-classifier', () => ({ classifyIntentByKeywords: (...a: unknown[]) => m.classify(...a) }));

const telegram = await import('@/app/api/telegram/webhook/route');

/** Строка блока 112 (lib/safety/sos-detector, SOS_HEAD.ru). */
const CALL_112 = 'Звоните 112';
const LOST = 'Помогите, мы заблудились';
/** Выдуманный номер: 7 900 000-00-00. В тексте модели и истории не должно быть его цифр. */
const PHONE = '+7 900 000-00-00';
const PHONE_DIGITS = '9000000000';
const LEGACY_ADMIN = 777;
const PARTNER_CHAT = 5151;
const ADMIN_TG = 880_001;
const PARTNER_PROMPT = 'Ты помощник партнёра';

let nextUpdateId = 24_100;

function post(text: string, chat: number): Promise<Response> {
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: {
        message_id: 1,
        from: { id: chat, first_name: 'Анна' },
        chat: { id: chat, type: 'private' },
        text,
      },
    }),
  }));
}

function partnerRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'vulkan-tur',
    name: 'Вулкан-Тур',
    category: 'operator',
    user_id: null,
    profile_status: null,
    ...over,
  };
}

type SentCall = { text?: string; replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };

/** Что получил человек: тексты всех отправленных сообщений. */
function sent(): string[] {
  return m.tgSend.mock.calls.map((c) => String((c[0] as SentCall).text ?? ''));
}

/** callback_data кнопок под всеми отправленными сообщениями. */
function buttons(): string[] {
  return m.tgSend.mock.calls.flatMap((c) =>
    ((c[0] as SentCall).replyMarkup?.inline_keyboard ?? []).flat().map((b) => String(b.callback_data ?? '')),
  );
}

/** Все сообщения, ушедшие в модели: цикл инструментов, водопады, одиночный вызов. */
function modelMessages(): Array<{ role: string; content: string }> {
  const lists = [
    ...m.tools.mock.calls.map((c) => c[0]),
    ...m.orNull.mock.calls.map((c) => c[0]),
    ...m.fallback.mock.calls.map((c) => c[0]),
    ...m.direct.mock.calls.map((c) => c[0]),
  ] as Array<Array<{ role?: string; content?: string | null }>>;
  return lists.flat().map((x) => ({ role: String(x.role ?? ''), content: String(x.content ?? '') }));
}

/** Есть ли где-то цифры выдуманного номера (пробелы и дефисы номера сняты). */
function carriesPhone(values: unknown[]): boolean {
  return values.some((v) => String(v ?? '').replace(/\D/g, '').includes(PHONE_DIGITS));
}

function conversationInserts(): unknown[][] {
  return m.pool.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO tg_conversations'))
    .map((c) => c[1] as unknown[]);
}

function systemPrompts(): string[] {
  return modelMessages().filter((x) => x.role === 'system').map((x) => x.content);
}

beforeEach(() => {
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  m.history = [];
  m.partner = null;
  m.admin = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', String(LEGACY_ADMIN));
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  // Наружу из теста ничего не ходит: подменён и сам fetch.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('INSERT INTO tg_conversations')) {
      m.history.push({ chat: params?.[0], mode: params?.[1], role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
      return { rows: [] };
    }
    if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
      // История — своего чата и рода, по убыванию времени: код разворачивает сам.
      const own = m.history.filter((h) => h.chat === params?.[0] && h.mode === params?.[1]);
      return { rows: own.map(({ role, content }) => ({ role, content })).reverse() };
    }
    if (q.includes('FROM partners') && q.includes('telegram_chat_id = $1')) {
      return { rows: m.partner && params?.[0] === PARTNER_CHAT ? [m.partner] : [] };
    }
    if (q.includes('admin_tg_bindings') && q.includes('user_id::text')) {
      return { rows: m.admin && params?.[0] === ADMIN_TG ? [m.admin] : [] };
    }
    return { rows: [] };
  });
  m.db.mockResolvedValue({ rows: [] });
  m.tgSend.mockResolvedValue({ success: true });
  m.tools.mockResolvedValue({ content: 'Ответ по делу.', provider: 'deepseek' });
  m.orNull.mockResolvedValue(null);
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
  m.createLead.mockResolvedValue('lead-1');
  m.createTicket.mockResolvedValue({ id: 'ticket-0001-abcd', category: 'other' });
  m.openTickets.mockResolvedValue([]);
  m.classify.mockReturnValue('unknown');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('беда в привязанном чате партнёра — Кузьмич туриста с блоком 112', () => {
  for (const category of ['operator', 'guide'] as const) {
    it(`${category}: «${LOST}» — строка «${CALL_112}», отвечает Кузьмич туриста, а не помощник кабинета`, async () => {
      m.partner = partnerRow({ category });
      const res = await post(LOST, PARTNER_CHAT);
      expect(await res.json()).toEqual({ ok: true });

      const out = sent();
      expect(out).toHaveLength(1);
      expect(out[0]).toContain(CALL_112);
      // Ответил мозг туриста: модель видела его промпт, не промпт помощника
      // партнёра, и под ответом нет строки меню роли.
      expect(m.tools).toHaveBeenCalled();
      expect(systemPrompts().some((s) => s.includes(PARTNER_PROMPT))).toBe(false);
      expect(buttons().some((b) => b.startsWith('rm:'))).toBe(false);
    });
  }

  it(`прокат «Лагуна»: «${LOST}» — строка «${CALL_112}», без строки кабинета проката`, async () => {
    m.partner = partnerRow({ slug: 'laguna-prokat', name: 'Лагуна Прокат', category: 'transfer' });
    await post(LOST, PARTNER_CHAT);

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CALL_112);
    expect(out[0]).not.toContain('Кабинет проката');
    expect(systemPrompts().some((s) => s.includes(PARTNER_PROMPT))).toBe(false);
    expect(buttons().some((b) => b.startsWith('rk:'))).toBe(false);
  });
});

describe('беда в привязанном чате администратора', () => {
  beforeEach(() => {
    m.admin = { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Анна' };
  });

  it(`«${LOST}» — строка «${CALL_112}», «Не понял команду» нет`, async () => {
    await post(LOST, ADMIN_TG);

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CALL_112);
    expect(out.join('\n')).not.toContain('Не понял команду');
  });

  it('беда со словом дела («запиши: …») у администратора — тоже Кузьмичу туриста с 112: CRM у него нет', async () => {
    await post('Запиши: клиентка Анна заблудилась у Авачи', ADMIN_TG);

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CALL_112);
    expect(out.join('\n')).not.toContain('Не понял команду');
    expect(buttons().some((b) => b.startsWith('rm:ad:'))).toBe(false);
  });
});

describe('дело CRM с бедой и телефоном — кабинет с блоком 112, телефон не уходит в модель и историю', () => {
  const CRM_SOS = `Запиши: клиентка Анна сломала ногу, помогите, телефон ${PHONE}`;

  beforeEach(() => {
    m.partner = partnerRow({ category: 'operator' });
  });

  it('ответ помощника кабинета несёт 112; во входе модели и в tg_conversations нет цифр номера', async () => {
    m.tools.mockResolvedValue({ content: 'Записал касание с Анной П.', provider: 'deepseek' });
    await post(CRM_SOS, PARTNER_CHAT);

    // Ответил кабинет: модель видела промпт помощника партнёра, под ответом — меню роли.
    expect(m.tools).toHaveBeenCalled();
    expect(systemPrompts().some((s) => s.includes(PARTNER_PROMPT))).toBe(true);
    expect(buttons()).toContain('rm:op:in');

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CALL_112);
    expect(out[0]).toContain('Записал касание с Анной П.');

    // Модель видит саму просьбу, но не номер.
    const seen = modelMessages();
    expect(seen.some((x) => x.role === 'user' && x.content.includes('сломала ногу'))).toBe(true);
    expect(carriesPhone(seen.map((x) => x.content))).toBe(false);
    // В историю — очищенное: история это вход модели на следующем ходу.
    const inserts = conversationInserts();
    expect(inserts.some((p) => p[1] === 'operator_tg' && p[2] === 'user')).toBe(true);
    expect(carriesPhone(inserts.flat())).toBe(false);
  });

  it('цикл инструментов не ответил — запасной водопад тоже без номера, ответ с 112', async () => {
    m.tools.mockResolvedValue(null);
    m.orNull.mockResolvedValue('Запасной ответ кабинета');
    await post(CRM_SOS, PARTNER_CHAT);

    expect(m.orNull).toHaveBeenCalled();
    const fallbackInput = (m.orNull.mock.calls[0]?.[0] ?? []) as Array<{ content?: string }>;
    expect(fallbackInput.some((x) => String(x.content ?? '').includes('сломала ногу'))).toBe(true);
    expect(carriesPhone(fallbackInput.map((x) => x.content))).toBe(false);
    expect(sent()).toEqual([expect.stringContaining(CALL_112)]);
    expect(sent()[0]).toContain('Запасной ответ кабинета');
  });

  it('строка истории, записанная до очистки, до модели не доходит с номером', async () => {
    m.history = [
      { chat: PARTNER_CHAT, mode: 'operator_tg', role: 'user', content: `Анна просила перезвонить на ${PHONE}` },
      { chat: PARTNER_CHAT, mode: 'operator_tg', role: 'assistant', content: 'Записал задачу перезвонить.' },
    ];
    await post('кто ждёт ответа?', PARTNER_CHAT);

    const seen = modelMessages();
    expect(seen.some((x) => x.content.includes('Анна просила перезвонить'))).toBe(true);
    expect(carriesPhone(seen.map((x) => x.content))).toBe(false);
  });

  // Дыра детектора, не этой правки: страдательное «сломана нога» и
  // «помогите» внутри фразы lib/safety/sos-detector не узнаёт (injury ловит
  // только «сломал(а) ногу»), и блок 112 не встаёт ни на одном пути.
  // Страдательное «сломана нога» детектор узнаёт с 25.10.
  it('«у клиента Анны сломана нога, помогите» — тоже 112', async () => {
    await post(`Запиши: у клиента Анны сломана нога, помогите, телефон ${PHONE}`, PARTNER_CHAT);
    expect(sent()[0]).toContain(CALL_112);
  });
});

describe('без беды блока 112 нет', () => {
  it('кабинет партнёра: «кто ждёт ответа?» — ответ помощника без 112', async () => {
    m.partner = partnerRow({ category: 'operator' });
    m.tools.mockResolvedValue({ content: 'Ждут ответа двое: Анна П. и Олег С.', provider: 'deepseek' });
    await post('кто ждёт ответа?', PARTNER_CHAT);

    expect(systemPrompts().some((s) => s.includes(PARTNER_PROMPT))).toBe(true);
    expect(sent()).toEqual(['Ждут ответа двое: Анна П. и Олег С.']);
    expect(sent().join('\n')).not.toContain('112');
  });

  it('кабинет администратора: непонятая фраза — справка без 112', async () => {
    m.admin = { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Анна' };
    await post('как дела', ADMIN_TG);

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Не понял команду');
    expect(out[0]).not.toContain('112');
  });
});
