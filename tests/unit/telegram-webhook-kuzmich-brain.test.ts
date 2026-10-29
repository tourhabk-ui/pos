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
import { RENTAL_SITE_PAUSE } from '@/lib/rental/site-pause';

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
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: {
    sendMessage: (...a: unknown[]) => m.tgSend(...a),
    answerCallback: vi.fn().mockResolvedValue(undefined),
  },
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

const PHONE = '+7 914 123-45-67';
const SOS_HEAD = 'ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ';
const TOURIST = 4242;
const ADMIN = 777;

// Свой update_id на каждый апдейт: вебхук пропускает повтор того же id.
let nextUpdateId = 9001;

function post(text: string, opts: { chat?: number; type?: string; from?: number; updateId?: number } = {}): Promise<Response> {
  const chat = opts.chat ?? TOURIST;
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: opts.updateId ?? nextUpdateId++,
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
  m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('INSERT INTO tg_conversations')) {
      m.history.push({ role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
      return { rows: [] };
    }
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/**
 * Часы внутри паузы проката (lib/rental/site-pause): тест про то, что просьба
 * туриста идёт в мозг, и улика этому — фраза о паузе. По настоящим часам она
 * пропала бы 26.10 в 12:00 UTC, и CI на main покраснел бы (перевод часов,
 * проверка качества 24.10). Время берётся от самой паузы: продление или новая
 * пауза тест не ломают.
 */
function insideRentalPause(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.parse(RENTAL_SITE_PAUSE.until) - 60 * 60 * 1000));
}

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

  it('повтор того же апдейта (Bot API не дождался ответа) — второго ответа и второй записи нет', async () => {
    await post('Когда лучше идти на Авачинский вулкан?', { updateId: 555001 });
    await post('Когда лучше идти на Авачинский вулкан?', { updateId: 555001 });
    expect(sent()).toEqual(['Ответ Кузьмича по делу.']);
    const timing = m.pool.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO ai_actions_log'));
    expect(timing).toHaveLength(1);
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

describe('турист: клавиатура, порядок ответов, даты каталога', () => {
  it('кнопка во время заявки не становится её текстом', async () => {
    await post('/start lead');
    await post('Подобрать тур');
    expect(sent().some((t) => t.includes('Заявка принята'))).toBe(false);
    expect(m.createLead).not.toHaveBeenCalled();
    await post('вулканы в августе, двое');
    expect(sent().some((t) => t.includes('Заявка принята'))).toBe(true);
    expect(m.createLead).toHaveBeenCalled();
    const comment = (m.createLead.mock.calls[0]?.[0] as { comment?: string } | undefined)?.comment;
    expect(comment).toContain('вулканы в августе');
    expect(comment).not.toContain('Подобрать тур');
  });

  it('/start — клавиатура Ведара, без текста кабинета оператора', async () => {
    await post('/start');
    const body = m.tgSend.mock.calls[0]?.[0] as { text?: string; replyMarkup?: { keyboard?: Array<Array<{ text: string }>> } };
    expect(body.text).toContain('Ведар');
    expect(body.text).not.toMatch(/TourHab|подключён к оператору|MAX/);
    expect(body.replyMarkup?.keyboard?.flat().map((b) => b.text)).toEqual([
      'Подобрать тур', 'Погода', 'Аренда авто', 'Операторы', 'Задать вопрос',
    ]);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('три вопроса одного чата отвечают по порядку, и следующий видит прошлый ответ', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let secondSeen = '';
    m.tools.mockImplementation(async (msgs: unknown) => {
      calls += 1;
      const mine = calls;
      if (mine === 1) await gate;
      if (mine === 2) secondSeen = JSON.stringify(msgs);
      const text = mine === 1 ? 'ОТВЕТ-ПЕРВЫЙ' : mine === 2 ? 'ОТВЕТ-ВТОРОЙ' : 'ОТВЕТ-ТРЕТИЙ';
      return { content: text, provider: 'deepseek' };
    });
    const first = post('первый вопрос про тропу');
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => { if (calls >= 1) { clearInterval(timer); resolve(); } }, 5);
      setTimeout(() => { clearInterval(timer); reject(new Error('модель не вызвана')); }, 3000);
    });
    const second = post('второй вопрос про берег');
    const third = post('третий вопрос про цену');
    // Пока первый ход ждёт модель, второй и третий стоят в очереди чата: ни
    // реплика не записана, ни модель не позвана. Без очереди второй ход за это
    // время успевает к модели — и тест краснеет (находка 24.10: порядок держали
    // тайминги, а не очередь).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toBe(1);
    expect(m.history.some((h) => h.content.includes('второй вопрос'))).toBe(false);
    release();
    await Promise.all([first, second, third]);
    const texts = sent();
    const i1 = texts.findIndex((t) => t.includes('ОТВЕТ-ПЕРВЫЙ'));
    const i2 = texts.findIndex((t) => t.includes('ОТВЕТ-ВТОРОЙ'));
    const i3 = texts.findIndex((t) => t.includes('ОТВЕТ-ТРЕТИЙ'));
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(secondSeen).toContain('ОТВЕТ-ПЕРВЫЙ');
    expect(secondSeen).toContain('первый вопрос про тропу');
  });

  it('«сколько стоит?» видит туры и цену, которые человек уже видел', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
    try {
    m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes('INSERT INTO tg_conversations')) {
        m.history.push({ role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
        return { rows: [] };
      }
      if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
        return { rows: [...m.history].reverse() };
      }
      if (q.includes('multi_day_count DESC NULLS LAST')) {
        return { rows: [{
          id: 7, slug: 'k-vulkanu', title: 'К вулкану',
          base_price: 180000, price_unit: 'per_person', multi_day_count: 1,
          season_start: '2026-09-01', season_end: '2026-10-31',
          activity_type: 'volcano', location_name: 'Авачинский',
        }] };
      }
      return { rows: [] };
    });
    await post('туры на вулканы');
    expect(m.tools).not.toHaveBeenCalled();
    const first = sent().join('\n');
    expect(first).toContain('К вулкану');
    expect(first).toMatch(/180/);
    expect(first).toContain('https://vedarai.ru/catalog/tours/k-vulkanu');
    const firstMarkup = m.tgSend.mock.calls[0]?.[0] as {
      replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; url: string }>> };
    };
    expect(firstMarkup.replyMarkup?.inline_keyboard).toEqual([[{
      text: 'Отправить запрос оператору',
      url: 'https://vedarai.ru/catalog/tours/k-vulkanu',
    }]]);
    await post('Сколько стоит?');
    expect(m.tools).not.toHaveBeenCalled();
    const second = sent().at(-1) ?? '';
    expect(second).toContain('К вулкану');
    expect(second).toMatch(/180/);
    expect(second).toContain('https://vedarai.ru/catalog/tours/k-vulkanu');
    expect(second).toContain('Отправить запрос оператору');
    } finally {
      vi.useRealTimers();
    }
  });

  it('«хочу арендовать авто» говорит про паузу витрины той же фразой, что кнопка', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    try {
      await post('Хочу арендовать авто');
      const out = sent().join('\n');
      expect(out).toContain('не показывается');
      expect(out).toContain('27 октября');
      expect(out).not.toMatch(/Лагуна|FLO/i);
      expect(out.split('не показывается').length - 1).toBe(1);
      expect(m.tools).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** Каталог витрины: один живой тур к Авачинскому, сезон накрывает 24.10.2026. */
  function withAvaCatalog(): void {
    m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes('INSERT INTO tg_conversations')) {
        m.history.push({ role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
        return { rows: [] };
      }
      if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
        return { rows: [...m.history].reverse() };
      }
      if (q.includes('multi_day_count DESC NULLS LAST')) {
        return { rows: [{
          id: 7, slug: 'k-vulkanu', title: 'К вулкану',
          base_price: 180000, price_unit: 'per_person', multi_day_count: 1,
          season_start: '2026-09-01', season_end: '2026-10-31',
          activity_type: 'volcano', location_name: 'Авачинский',
        }] };
      }
      return { rows: [] };
    });
  }

  it.each([
    'Какие опасности на Авачинском вулкане?',
    'Какие вулканы сейчас извергаются?',
    'Безопасен ли тур на вулкан при сильном ветре?',
  ])('вопрос о безопасности «%s» — отвечает модель, туров с ценой нет (находка 24.10)', async (question) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
    try {
      withAvaCatalog();
      await post(question);
      expect(m.tools).toHaveBeenCalled();
      const out = sent().join('\n');
      expect(out).toContain('Ответ Кузьмича по делу.');
      expect(out).not.toContain('Туры из каталога');
      expect(out).not.toContain('/catalog/tours/k-vulkanu');
      expect(out).not.toMatch(/180/);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['Хочу арендовать джип', 'Аренда внедорожника', 'Прокат 4x4 на выходные'])(
    '«%s» — пауза проката той же фразой, без туров и без модели (находка 24.10)',
    async (question) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
      try {
        withAvaCatalog();
        await post(question);
        expect(m.tools).not.toHaveBeenCalled();
        const out = sent().join('\n');
        expect(out).toContain('не показывается');
        expect(out).toContain('27 октября');
        expect(out).not.toContain('Туры из каталога');
        expect(out).not.toContain('/catalog/tours/');
        expect(out).not.toMatch(/Лагуна|FLO/i);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('кнопка «Операторы» — отбор и порядок витрины, «первые N из M», пауза проката (находка 24.10)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    try {
      const names = Array.from({ length: 10 }, (_, i) => ({ name: `Компания ${i + 1} <б>`, slug: `kompaniya-${i + 1}` }));
      m.db.mockImplementation(async (sql: unknown) => {
        const q = String(sql);
        if (q.includes('FROM users WHERE telegram_id')) return { rows: [] };
        if (q.includes('COUNT(*)') && q.includes('FROM partners p')) return { rows: [{ total: '14' }] };
        if (q.includes('FROM partners p')) return { rows: names };
        return { rows: [] };
      });
      await post('Операторы');
      expect(m.tools).not.toHaveBeenCalled();
      const out = sent().join('\n');
      expect(out).toContain('первые 10 из 14');
      expect(out).toContain('Место в списке не продаётся');
      expect(out).toContain('href="https://vedarai.ru/operators/kompaniya-1"');
      expect(out).toContain('Компания 1 &lt;б&gt;');
      expect(out).not.toContain('/operators/null');
      // Отбор — тот же, что у /operators; спрятанный паузой прокат передан в запрос.
      const list = m.db.mock.calls.find((c) => String(c[0]).includes('FROM partners p') && !String(c[0]).includes('COUNT'));
      expect(String(list?.[0])).toMatch(/slug IS NOT NULL/);
      expect(String(list?.[0])).toMatch(/category <> 'transfer'/);
      expect(String(list?.[0])).toMatch(/category <> 'cars'/);
      expect((list?.[1] as unknown[])[0]).toEqual(['laguna-prokat']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('кнопка «Операторы»: база не ответила — «не загрузился», а не «пусто»; SQLSTATE в логе', async () => {
    m.db.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FROM users WHERE telegram_id')) return { rows: [] };
      if (q.includes('FROM partners p')) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return { rows: [] };
    });
    await post('Операторы');
    const out = sent().join('\n');
    expect(out).toContain('не загрузился');
    expect(out).not.toContain('нет ни одной компании');
    expect(out).not.toContain('пока пуст');
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[telegram/operators]') && l.includes('sqlstate=42P01'))).toBe(true);
  });

  it('июль получает даты каталога, а не выдуманный заезд', async () => {
    m.pool.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) return { rows: [] };
      if (q.includes('multi_day_count DESC NULLS LAST')) {
        return { rows: [{
          id: 7, slug: 'pyat-dney', title: 'Пять дней по Камчатке',
          base_price: 180000, price_unit: 'per_person', multi_day_count: 5,
          season_start: '2027-08-25', season_end: '2027-09-30',
        }] };
      }
      return { rows: [] };
    });
    await post('Что посмотреть за 5 дней в июле?');
    expect(m.tools).not.toHaveBeenCalled();
    const out = sent().join('\n');
    expect(out).toContain('нет тура, который идёт');
    expect(out).toContain('в это окно не попадают');
    expect(out).toContain('25 августа 2027');
    expect(out).toContain('Отправить запрос оператору');
    expect(out).toContain('https://vedarai.ru/catalog/tours/pyat-dney');
    expect(out).not.toContain('180');
    expect(out).not.toMatch(/подключён к оператору/);
    const last = m.tgSend.mock.calls.at(-1)?.[0] as {
      replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>> };
    };
    expect(last.replyMarkup?.inline_keyboard).toEqual([[{
      text: 'Отправить запрос оператору',
      url: 'https://vedarai.ru/catalog/tours/pyat-dney',
    }]]);
  });
});

describe('кабинет проката на живом вебхуке', () => {
  const PARTNER = '22222222-2222-4222-8222-222222222222';
  const CHAT = 4242;
  const LEAD = '33333333-3333-4333-8333-333333333333';
  const CUSTOMER = 'Иван Заказчиков';

  beforeEach(() => {
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    m.pool.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) return { rows: [] };
      if (q.includes('FROM partners')) {
        return { rows: [{ id: PARTNER, slug: 'laguna-prokat', name: 'Лагуна Прокат', category: 'transfer', user_id: null, profile_status: null }] };
      }
      // Заявка на прокат в базе: имя и телефон заказчика есть, в Telegram их быть не должно.
      if (q.includes('FROM leads l') && q.includes("'car_rental'")) {
        return { rows: [{
          id: LEAD, name: CUSTOMER, phone: PHONE, title: 'Suzuki Jimny',
          date_from: '2026-11-10', date_to: '2026-11-12', answer: null,
        }] };
      }
      return { rows: [] };
    });
  });

  function pressButton(data: string): Promise<Response> {
    return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify({
        update_id: nextUpdateId++,
        callback_query: {
          id: 'cq-1',
          from: { id: CHAT, first_name: 'Акбар' },
          message: { message_id: 5, chat: { id: CHAT, type: 'private' } },
          data,
        },
      }),
    }));
  }

  it('/start пилота не обещает заявок с кнопками здесь: они в MAX', async () => {
    await post('/start', { chat: CHAT, from: CHAT });
    const out = sent().join('\n');
    expect(out).toContain('Лагуна Прокат');
    expect(out).toContain('приходит в MAX');
    expect(out).toContain('без контактов и без кнопок');
    expect(out).not.toContain('приходят сюда');
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('«Заявки» текстом — список без имени и телефона заказчика', async () => {
    await post('Заявки', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    const out = sent().join('\n');
    expect(out).toContain('Suzuki Jimny');
    expect(out).toContain('в Telegram не передаются');
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(CUSTOMER);
    const markup = (m.tgSend.mock.calls[0]?.[0] as { replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } }).replyMarkup;
    expect(markup?.inline_keyboard?.[0]?.map((b) => b.text)).toEqual(['Беру №1', 'Не могу №1']);
  });

  it('кнопка «Заявки» — тот же список без имени и телефона', async () => {
    await pressButton('rk:req');
    const out = sent().join('\n');
    expect(out).toContain('Suzuki Jimny');
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(CUSTOMER);
  });

  it('«Помощь» — справка со строкой кнопок, не мозг туриста', async () => {
    await post('Помощь', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    expect(sent()).toEqual([expect.stringContaining('Кабинет проката')]);
    const markup = (m.tgSend.mock.calls[0]?.[0] as { replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> } }).replyMarkup;
    const last = markup?.inline_keyboard?.[markup.inline_keyboard.length - 1] ?? [];
    expect(last.map((b) => b.callback_data)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
  });

  function cabinetMarkup(call: number): string[] {
    const markup = (m.tgSend.mock.calls[call]?.[0] as { replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> } }).replyMarkup;
    const last = markup?.inline_keyboard?.[markup.inline_keyboard.length - 1] ?? [];
    return last.map((b) => b.callback_data);
  }

  it('ответ модели с голым `<` доходит экранированным, строка кнопок на месте', async () => {
    m.tools.mockResolvedValue({ content: 'Залог < 5000 & ветер', provider: 'deepseek' });
    await post('как дела', { chat: CHAT, from: CHAT });
    expect(sent()).toEqual(['Залог &lt; 5000 &amp; ветер']);
    expect(cabinetMarkup(0)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
  });

  it('Bot API не принял HTML кабинета — второй раз без тегов, кнопки те же', async () => {
    m.tgSend
      .mockResolvedValueOnce({ success: false, error: "can't parse entities" })
      .mockResolvedValueOnce({ success: true });
    m.tools.mockResolvedValue({ content: 'Ответ <u>с подчёркиванием</u>', provider: 'deepseek' });
    await post('как дела', { chat: CHAT, from: CHAT });
    expect(sent()).toEqual(['Ответ <u>с подчёркиванием</u>', 'Ответ с подчёркиванием']);
    expect(cabinetMarkup(0)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
    expect(cabinetMarkup(1)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
  });

  it('не принят и простой текст — отказ в логе, вебхук не делает вид, что отправил', async () => {
    m.tgSend.mockResolvedValue({ success: false, error: 'bot blocked' });
    m.tools.mockResolvedValue({ content: 'Короткий ответ', provider: 'deepseek' });
    const res = await post('как дела', { chat: CHAT, from: CHAT });
    expect(await res.json()).toEqual({ ok: true });
    expect(sent()).toHaveLength(2);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('ответ кабинета не доставлен'))).toBe(true);
  });

  it('просьба туриста в том же чате идёт в мозг без строки кабинета', async () => {
    insideRentalPause();
    await post('найди мне в аренду автомобиль', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    const body = m.tgSend.mock.calls[0]?.[0] as { text?: string; replyMarkup?: { inline_keyboard?: unknown; keyboard?: Array<Array<{ text: string }>> } };
    expect(body.text).toContain('не показывается');
    expect((body.text ?? '').split('vedarai.ru/transfers').length - 1).toBe(1);
    expect(body.text).not.toContain('Отправить запрос');
    expect(body.text).not.toMatch(/Лагуна|Кабинет проката/);
    expect(body.replyMarkup?.inline_keyboard).toBeUndefined();
    expect(body.replyMarkup?.keyboard?.flat().map((b) => b.text)).toEqual([
      'Подобрать тур', 'Погода', 'Аренда авто', 'Операторы', 'Задать вопрос',
    ]);
  });
});

describe('меню роли на живом вебхуке', () => {
  const PARTNER = '11111111-1111-4111-8111-111111111111';
  const CHAT = 5151;

  function lastRow(call = 0): string[] {
    const markup = (m.tgSend.mock.calls[call]?.[0] as { replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> } }).replyMarkup;
    const last = markup?.inline_keyboard?.[markup.inline_keyboard.length - 1] ?? [];
    return last.map((b) => b.callback_data);
  }

  beforeEach(() => {
    m.pool.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) return { rows: [] };
      if (q.includes('FROM partners')) {
        return { rows: [{ id: PARTNER, slug: 'mesto-kamchatka', name: 'Местечко', category: 'operator', user_id: null, profile_status: null }] };
      }
      return { rows: [] };
    });
  });

  it('«Входящие» — список кабинета со строкой роли, не мозг туриста', async () => {
    await post('Входящие', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    expect(sent()[0]).toContain('Входящие');
    expect(sent().join('\n')).not.toMatch(/\+7|телефон/i);
    expect(lastRow()).toEqual(['rm:op:in', 'rm:op:hp']);
    expect(lastRow().join(' ')).not.toContain('rk:');
  });

  it('«найди мне в аренду автомобиль» — мозг туриста, без меню роли', async () => {
    insideRentalPause();
    await post('найди мне в аренду автомобиль', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    const body = m.tgSend.mock.calls[0]?.[0] as { text?: string; replyMarkup?: { inline_keyboard?: unknown; keyboard?: Array<Array<{ text: string }>> } };
    expect(body.text).toContain('не показывается');
    expect((body.text ?? '').split('vedarai.ru/transfers').length - 1).toBe(1);
    expect(body.text).not.toContain('Отправить запрос');
    expect(body.text).not.toMatch(/Кабинет|Входящие/);
    expect(body.replyMarkup?.inline_keyboard).toBeUndefined();
    expect(body.replyMarkup?.keyboard?.flat().map((b) => b.text)).toContain('Аренда авто');
  });

  it('«как дела» остаётся помощнику кабинета, строка роли под ответом', async () => {
    m.tools.mockResolvedValue({ content: 'Дела в порядке', provider: 'deepseek' });
    await post('как дела', { chat: CHAT, from: CHAT });
    expect(m.tools).toHaveBeenCalled();
    expect(sent()).toEqual(['Дела в порядке']);
    expect(lastRow()).toEqual(['rm:op:in', 'rm:op:hp']);
  });

  it('«открой субботы июля, 8 мест» — это в MAX, помощник даты не открывает', async () => {
    await post('открой субботы июля, 8 мест', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    expect(sent()[0]).toMatch(/^Открыть даты словами можно в MAX/);
    expect(lastRow()).toEqual(['rm:op:in', 'rm:op:hp']);
  });

  it('гид со своими турами (29.10): та же фраза — «это в MAX» со ссылкой в его раздел «Свои туры», помощник не зовётся', async () => {
    const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    m.pool.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) return { rows: [] };
      if (q.includes('FROM partners')) {
        return { rows: [{ id: PARTNER, slug: 'g-own', name: 'Гид', category: 'guide', user_id: USER, profile_status: null, sells_tours: true }] };
      }
      return { rows: [] };
    });
    await post('открой субботы июля, 8 мест', { chat: CHAT, from: CHAT });
    expect(m.tools).not.toHaveBeenCalled();
    expect(sent()[0]).toMatch(/^Открыть даты словами можно в MAX — там есть кнопка подтверждения\. Или в кабинете: https?:\/\/\S+\/hub\/guide\/own$/);
    expect(sent().join('\n')).not.toMatch(/\/hub\/operator/);
  });

  it('«Входящие» называют непрочитанные чата, если у партнёра есть аккаунт', async () => {
    const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    m.pool.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FROM partners')) {
        return { rows: [{ id: PARTNER, slug: 'mesto-kamchatka', name: 'Местечко', category: 'operator', user_id: USER, profile_status: null }] };
      }
      return { rows: [] };
    });
    m.db.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('conversation_participants')) return { rows: [{ total: '4' }] };
      return { rows: [] };
    });
    await post('Входящие', { chat: CHAT, from: CHAT });
    expect(sent()[0]).toContain('Непрочитанных сообщений в чате кабинета: 4');
    expect(sent().join('\n')).not.toMatch(/\+7|Анна/);
  });

  it('/help администратора несёт шесть кнопок чтения', async () => {
    await post('/help', { chat: ADMIN, from: ADMIN });
    expect(m.tools).not.toHaveBeenCalled();
    expect(sent()[0]).toContain('Команды Кузьмича');
    expect(lastRow()).toEqual(['rm:ad:dt', 'rm:ad:bk', 'rm:ad:ld', 'rm:ad:sm', 'rm:ad:hl', 'rm:ad:hp']);
  });
});
