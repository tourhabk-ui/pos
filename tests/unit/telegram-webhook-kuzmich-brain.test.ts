/**
 * Живой вход Telegram отвечает общим мозгом Кузьмича (аудит 15.10, TG-BRAIN).
 *
 * Канонический вебхук /api/telegram/webhook до 15.10 отвечал туристу своей
 * копией Кузьмича: одиночный вызов модели с сырым текстом. «Мы заблудились,
 * телефон +7 914 …» уходило в зарубежную модель вместе с номером, а ответ
 * приходил без серверного блока 112 — притом что веб, MAX и второй вход того
 * же бота шли через lib/kuzmich/core, а политика обещала чистку для Telegram.
 *
 * Сторож — вызов роута с настоящим мозгом (lib/kuzmich/core, детектор ЧП,
 * чистка ПД): подменены только модель, база и транспорт. Судится то, что
 * видит модель (нет телефона) и что получает человек (блок 112 есть / нет).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  fallback: vi.fn(),
  direct: vi.fn(),
  tgSend: vi.fn(),
  createLead: vi.fn(),
  createTicket: vi.fn(),
  openTickets: vi.fn(),
  addTicketMessage: vi.fn(),
  dispatch: vi.fn(),
  classify: vi.fn(),
  /** История разговора в tg_conversations — по возрастанию времени. */
  history: [] as Array<{ role: string; content: string }>,
  /** Строка users по telegram_id: есть — турист привязан к аккаунту. */
  linkedUser: null as null | { id: string; name: string; role: string; email: string },
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.pool(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
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
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a) } }));
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

const PHONE = '+7 914 123-45-67';
const SOS_HEAD = 'ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ';
const TOURIST = 4242;
const ADMIN = 777;

function post(text: string, opts: { chat?: number; type?: string; from?: number } = {}): Promise<Response> {
  const chat = opts.chat ?? TOURIST;
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: 9001,
      message: {
        message_id: 1,
        from: { id: opts.from ?? chat, first_name: 'Анна' },
        chat: { id: chat, type: opts.type ?? 'private' },
        text,
      },
    }),
  }));
}

/** Всё, что ушло в модели: цикл инструментов, запасной водопад, одиночный вызов. */
function modelInput(): string {
  const msgs = [
    ...m.tools.mock.calls.map((c) => c[0]),
    ...m.fallback.mock.calls.map((c) => c[0]),
    ...m.direct.mock.calls.map((c) => c[0]),
  ] as Array<Array<{ content: string | null }>>;
  return msgs.flat().map((x) => x.content ?? '').join('\n');
}

/** Что получил человек: тексты всех отправленных сообщений. */
function sent(): string[] {
  return m.tgSend.mock.calls.map((c) => String((c[0] as { text: string }).text));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.history = [];
  m.linkedUser = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', String(ADMIN));
  // Наружу из теста ничего не ходит: подменён и сам fetch.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.pool.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
      // Запрос истории — по убыванию времени, код разворачивает сам.
      return { rows: [...m.history].reverse() };
    }
    return { rows: [] };
  });
  m.db.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('FROM users WHERE telegram_id')) return { rows: m.linkedUser ? [m.linkedUser] : [] };
    return { rows: [] };
  });
  m.tgSend.mockResolvedValue({ success: true });
  m.tools.mockResolvedValue({ content: 'Ответ Кузьмича по делу.', provider: 'deepseek' });
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
  m.createLead.mockResolvedValue('lead-1');
  m.createTicket.mockResolvedValue({ id: 'ticket-0001-abcd', category: 'other' });
  m.openTickets.mockResolvedValue([]);
  m.classify.mockReturnValue('unknown');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('личка: свободный текст идёт в мозг Кузьмича', () => {
  it('«мы заблудились, телефон …» — телефон до модели не доходит, ответ несёт блок 112', async () => {
    const res = await post(`мы заблудились, телефон ${PHONE}`);
    expect(await res.json()).toEqual({ ok: true });

    // Мозг — цикл инструментов, не одиночный вызов мимо него.
    expect(m.tools).toHaveBeenCalled();
    expect(m.direct).not.toHaveBeenCalled();
    const seen = modelInput();
    expect(seen).toContain('мы заблудились');
    expect(seen).not.toContain('914');
    expect(seen).not.toContain('123-45-67');

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_HEAD);
    expect(out[0]).toContain('112');
    expect(out[0]).toContain('Ответ Кузьмича по делу.');
  });

  it('модели не ответили все — человек всё равно получает блок 112', async () => {
    m.tools.mockResolvedValue(null);
    m.fallback.mockResolvedValue({ text: '', provider: null, tier: 3, failed: true });

    await post(`мы заблудились, телефон ${PHONE}`);

    expect(modelInput()).not.toContain('914');
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_HEAD);
  });

  it('мозг упал исключением — ответ о сбое, и на беду он тоже несёт блок 112', async () => {
    m.tools.mockRejectedValue(new Error('цикл упал'));
    m.fallback.mockRejectedValue(new Error('водопад упал'));

    const res = await post('мы заблудились у Мутновского');
    expect(await res.json()).toEqual({ ok: true });

    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_HEAD);
    expect(out[0]).toContain('сбой на нашей стороне');
    // Отказ назван в логе, а не проглочен (§4.0).
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.startsWith('[telegram/webhook] ответ Кузьмича'))).toBe(true);
  });

  it('обычный вопрос — ответ модели без блока 112, замер пишется один раз', async () => {
    await post('Когда лучше идти на Авачинский вулкан?');

    expect(modelInput()).toContain('Когда лучше идти на Авачинский вулкан?');
    const out = sent();
    expect(out).toEqual(['Ответ Кузьмича по делу.']);

    const timing = m.pool.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO ai_actions_log'));
    expect(timing).toHaveLength(1);
    expect(JSON.parse(String((timing[0]![1] as unknown[])[2]))).toMatchObject({ surface: 'telegram', path: 'tools' });
  });

  it('история пишется в tg_conversations под режимом tourist, имя туриста не хранится', async () => {
    await post('Когда лучше идти на Авачинский вулкан?');

    const saved = m.pool.mock.calls
      .filter((c) => String(c[0]).includes('INSERT INTO tg_conversations'))
      .map((c) => c[1] as unknown[]);
    // Реплика туриста и ответ — две строки, обе под тем же chat_id и режимом.
    expect(saved.map((p) => [p[0], p[1], p[2]])).toEqual([
      [TOURIST, 'tourist', 'user'],
      [TOURIST, 'tourist', 'assistant'],
    ]);
    // Имя (first_name «Анна») в историю не пишется: его там никто не читает.
    for (const p of saved) expect(p[5]).toBeNull();
    expect(JSON.stringify(m.pool.mock.calls)).not.toContain('Анна');
  });

  it('телефон из прошлых реплик истории до модели тоже не доходит', async () => {
    m.history = [
      { role: 'user', content: `запишите мой номер ${PHONE}` },
      { role: 'assistant', content: 'Записывать номер не нужно, спрашивайте.' },
    ];
    await post('А что взять на восхождение?');

    const seen = modelInput();
    expect(seen).toContain('запишите мой номер');
    expect(seen).not.toContain('914');
  });

  it('беда с номером после разговора о рыбалке — не «горячий лид» оператору, а ответ с блоком 112', async () => {
    m.history = [
      { role: 'user', content: 'хочу на рыбалку в июле' },
      { role: 'assistant', content: 'Есть туры на рыбалку.' },
    ];
    await post(`мы заблудились, телефон ${PHONE}`);

    expect(m.createLead).not.toHaveBeenCalled();
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_HEAD);
    expect(out[0]).not.toContain('Оператор свяжется');
  });

  it('номер после разговора о рыбалке без беды — лид, как раньше (интересы — из истории Кузьмича)', async () => {
    m.history = [
      { role: 'user', content: 'хочу на рыбалку в июле' },
      { role: 'assistant', content: 'Есть туры на рыбалку.' },
    ];
    await post(PHONE);

    expect(m.createLead).toHaveBeenCalledTimes(1);
    expect(m.tools).not.toHaveBeenCalled();
    expect(sent().some((t) => t.includes('Оператор свяжется'))).toBe(true);
  });
});

describe('упоминание в группе — тот же мозг и тот же блок', () => {
  it('«@бот мы заблудились, звоните …» — телефон до модели не доходит, в группу уходит блок 112', async () => {
    const GROUP = -1001234567890;
    await post(`@kuzmichai_bot мы заблудились у Авачи, звоните ${PHONE}`, { chat: GROUP, type: 'supergroup', from: TOURIST });

    expect(m.tools).toHaveBeenCalled();
    expect(m.direct).not.toHaveBeenCalled();
    const seen = modelInput();
    expect(seen).toContain('мы заблудились у Авачи');
    expect(seen).not.toContain('914');
    expect(seen).not.toContain('@kuzmichai_bot');

    expect(m.tgSend).toHaveBeenCalledTimes(1);
    expect(m.tgSend).toHaveBeenCalledWith(expect.objectContaining({ chatId: String(GROUP) }));
    expect(sent()[0]).toContain(SOS_HEAD);
  });

  it('без упоминания бот в группе молчит', async () => {
    await post('мы заблудились', { chat: -100555, type: 'group' });
    expect(m.tgSend).not.toHaveBeenCalled();
    expect(m.tools).not.toHaveBeenCalled();
  });
});

describe('/sezon — тот же мозг', () => {
  it('история с телефоном туриста до модели не доходит', async () => {
    m.history = [{ role: 'user', content: `мой номер ${PHONE}` }];
    await post('/sezon');

    expect(m.tools).toHaveBeenCalled();
    expect(m.direct).not.toHaveBeenCalled();
    expect(modelInput()).not.toContain('914');
    expect(sent()).toEqual(['Ответ Кузьмича по делу.']);
  });
});

describe('тикеты поддержки и админ-интенты работают как раньше', () => {
  it('«помогите, мы заблудились» у привязанного туриста — тикет создан, и в ответе блок 112', async () => {
    m.linkedUser = { id: 'u-1', name: 'Анна Петрова', role: 'tourist', email: 'a@example.ru' };
    await post('помогите, мы заблудились');

    expect(m.createTicket).toHaveBeenCalledTimes(1);
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Обращение принято');
    expect(out[0]).toContain(SOS_HEAD);
  });

  it('обычное обращение в поддержку — тикет без блока 112', async () => {
    m.linkedUser = { id: 'u-1', name: 'Анна Петрова', role: 'tourist', email: 'a@example.ru' };
    await post('оператор не отвечает на заявку');

    expect(m.createTicket).toHaveBeenCalledTimes(1);
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Обращение принято');
    expect(out[0]).not.toContain(SOS_HEAD);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('открытый тикет дополняется, ответ — как раньше', async () => {
    m.linkedUser = { id: 'u-1', name: 'Анна Петрова', role: 'tourist', email: 'a@example.ru' };
    m.openTickets.mockResolvedValue([{ id: 'ticket-0002-efgh', category: 'other', assignedAgent: null }]);
    await post('деньги не пришли');

    expect(m.addTicketMessage).toHaveBeenCalledWith('ticket-0002-efgh', { role: 'user', text: 'деньги не пришли' });
    expect(sent()[0]).toContain('обновлён');
  });

  it('беда у непривязанного — без «зарегистрируйтесь», сразу Кузьмич с блоком 112', async () => {
    await post('помогите, мы заблудились');

    expect(m.createTicket).not.toHaveBeenCalled();
    const out = sent();
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('нужен аккаунт');
    expect(out[0]).toContain(SOS_HEAD);
  });

  it('обычное обращение непривязанного — «нужен аккаунт», затем ответ Кузьмича', async () => {
    await post('не могу войти в кабинет');

    const out = sent();
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('нужен аккаунт');
    expect(out[1]).toBe('Ответ Кузьмича по делу.');
  });

  it('админ: свободный текст с интентом — PlatformAgent, модель Кузьмича не зовётся', async () => {
    m.classify.mockReturnValue('leads');
    m.dispatch.mockResolvedValue({ response: 'Лидов сегодня: 3', intent: 'leads', duration_ms: 5 });

    await post('покажи лиды за сегодня', { chat: ADMIN, from: ADMIN });

    expect(m.dispatch).toHaveBeenCalledWith({ message: 'покажи лиды за сегодня', role: 'admin' });
    expect(sent()).toEqual(['Лидов сегодня: 3']);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('админ: агент упал — отказ в логе, отвечает Кузьмич', async () => {
    m.classify.mockReturnValue('leads');
    m.dispatch.mockRejectedValue(new Error('агент упал'));

    await post('покажи лиды за сегодня', { chat: ADMIN, from: ADMIN });

    expect(sent()).toEqual(['Ответ Кузьмича по делу.']);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('PlatformAgent'))).toBe(true);
  });
});

describe('доставка ответа', () => {
  it('голый `<` в ответе модели не роняет сообщение: экранируется до отправки', async () => {
    // Прежний sendHTML слал ответ как есть, Bot API отвечал 400 «can't parse
    // entities», и турист не получал ничего.
    m.tools.mockResolvedValue({ content: 'Высота там <2000 м & ветер', provider: 'deepseek' });
    await post('Какая там высота?');

    expect(sent()).toEqual(['Высота там &lt;2000 м &amp; ветер']);
  });

  it('Bot API не принял HTML — второй раз простым текстом', async () => {
    m.tgSend.mockResolvedValueOnce({ success: false, error: "can't parse entities" });
    m.tools.mockResolvedValue({ content: 'Ответ <u>с подчёркиванием</u>', provider: 'deepseek' });
    await post('Расскажи про Халактырский пляж');

    expect(sent()).toEqual(['Ответ <u>с подчёркиванием</u>', 'Ответ с подчёркиванием']);
  });
});
