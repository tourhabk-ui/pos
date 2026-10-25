/**
 * Беда перебивает заявку в чате (проверка качества 24.10) — вызовом
 * настоящего processMessage (lib/kuzmich/core) с подменёнными моделью и
 * базой.
 *
 * До правки живой черновик брони забирал любое сообщение чата раньше
 * Кузьмича: шаг «имя» отвечал на «Помогите, мы заблудились» «Укажите имя и
 * фамилию», шаг «подтверждение» читал «…связи нет» как «нет» и писал
 * «Заявка отменена» — оба без единого слова о 112. Слово брони в фразе беды
 * («медведь подходит», «запишите координаты») начинало новую заявку, а
 * незаверенный апдейт MAX с живым черновиком получал «заявку не оформляю».
 *
 * Что держит:
 *  - беда при живом черновике (Telegram и заверенный MAX) — черновик снят
 *    (память и tg_booking_flow), ответ модели с блоком 112, шаг брони не
 *    отвечает;
 *  - «нет» внутри фразы беды заявку не отменяет;
 *  - слово брони во фразе беды заявку не начинает;
 *  - черновик, который база не удалила, беду всё равно не перехватывает;
 *  - незаверенный MAX с живым черновиком получает блок 112, а не отказ
 *    оформлять заявку, и ничего не пишет;
 *  - без беды шаги брони работают как раньше (имя, отмена словом «нет»).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tools, fallback, fast, query } = vi.hoisted(() => ({
  tools: vi.fn(),
  fallback: vi.fn(),
  fast: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => tools(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => fallback(...a),
  callAIFast: (...a: unknown[]) => fast(...a),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/route-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/route-knowledge')>()),
  searchRoutes: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', () => ({ searchOperatorAvailability: vi.fn().mockResolvedValue('') }));
// Контроль выхода судится своим сторожем (trip-watch-chat).
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));

import { processMessage, type PendingBooking } from '@/lib/kuzmich/core';
import { UNVERIFIED_CHAT_REPLY } from '@/lib/max/verified-press';

const CHAT = 77;
const SOS_LINE = 'Звоните 112';
// Без «112» и «МЧС»: иначе блок не добавляется (модель «уже дала телефоны»).
const MODEL_ANSWER = 'ОТВЕТ МОЗГА КУЗЬМИЧА';
const reply = vi.fn();
const base = { userName: 'Анна', userId: 501, createdVia: 'tg', reply };

const TOUR = { id: 5, title: 'Рыбалка на Быстрой', base_price: 15000, operator_id: 'op-1' } as unknown as PendingBooking['tour'];

/** Черновик на шаге «имя»: тур выбран, бот спросил «Как вас зовут?». */
function nameStep(): PendingBooking {
  return { step: 'name', started_at: Date.now() - 60_000, tour: TOUR };
}

/** Черновик на шаге «Всё верно? Да / Нет». Номер выдуманный. */
function confirmStep(): PendingBooking {
  return {
    step: 'confirm', started_at: Date.now() - 60_000, tour: TOUR,
    name: 'Анна Петрова', phone: '+79000000000', participants: 2, date: '2026-11-20',
  };
}

/** Что ушло в чат одной строкой. */
const said = (): string => reply.mock.calls.map((c) => String(c[1])).join('\n');

const sqlCalls = (): string[] => query.mock.calls.map((c) => String(c[0]));
const draftDeleted = (): boolean => sqlCalls().some((sql) => sql.includes('DELETE FROM tg_booking_flow'));
const draftWritten = (): boolean => sqlCalls().some((sql) => sql.includes('INSERT INTO tg_booking_flow'));
const bookingCreated = (): boolean => sqlCalls().some((sql) => /INSERT INTO operator_bookings/i.test(sql));
const chatStateWrites = (): string[] =>
  sqlCalls().filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql) && /tg_conversations|agent_memory|tg_booking_flow/.test(sql));

/** Дать дойти записям «выстрелил и забыл» (память бота, заметки). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  for (const f of [tools, fallback, fast, query, reply]) f.mockReset();
  query.mockResolvedValue({ rows: [] });
  reply.mockResolvedValue(undefined);
  fast.mockResolvedValue('нет');
  fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
  tools.mockResolvedValue({ content: MODEL_ANSWER, provider: 'test' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('беда при живом черновике брони', () => {
  it.each([
    ['Telegram', 'tg' as const, true],
    ['MAX, заверенный апдейт', 'max' as const, true],
  ])('%s: «Помогите, мы заблудились» на шаге «имя» — черновик снят, ответ модели с 112', async (_name, platform, verifiedOrigin) => {
    const pending = new Map([[CHAT, nameStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: platform, text: 'Помогите, мы заблудились', pending, platform, verifiedOrigin });
    await settle();

    expect(said()).toContain(SOS_LINE);
    expect(said()).toContain(MODEL_ANSWER);
    expect(said()).not.toContain('Укажите имя');
    expect(said()).not.toContain('Заявка отменена');
    expect(reply).toHaveBeenCalledTimes(1);
    // Черновик снят и в памяти, и в базе: следующее сообщение — не шаг брони.
    expect(pending.has(CHAT)).toBe(false);
    expect(draftDeleted()).toBe(true);
    // Вопрос дошёл до модели.
    const sent = tools.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toContain('Помогите, мы заблудились');
  });

  it('«Мы заблудились, связи нет» на шаге подтверждения — «нет» не отменяет заявку словами, брони оператору нет', async () => {
    const pending = new Map([[CHAT, confirmStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: 'max', text: 'Мы заблудились, связи нет', pending, platform: 'max', verifiedOrigin: true });
    await settle();

    expect(said()).toContain(SOS_LINE);
    expect(said()).toContain(MODEL_ANSWER);
    expect(said()).not.toContain('Заявка отменена');
    expect(pending.has(CHAT)).toBe(false);
    expect(draftDeleted()).toBe(true);
    expect(bookingCreated()).toBe(false);
  });

  it('база не удалила черновик — беда всё равно не уходит в шаг брони', async () => {
    // Черновик лежит в tg_booking_flow (контейнер перезапускался — в памяти
    // его нет), а DELETE не прошёл: загрузка в шаге брони нашла бы его снова.
    const pending = new Map<number, PendingBooking>();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tg_booking_flow') && /SELECT/.test(sql)) return { rows: [{ state: nameStep() }] };
      if (sql.includes('DELETE FROM tg_booking_flow')) throw new Error('connection terminated');
      return { rows: [] };
    });
    await processMessage({ ...base, chatId: CHAT, mode: 'tg', text: 'Помогите, мы заблудились', pending, platform: 'tg' });
    await settle();

    expect(said()).toContain(SOS_LINE);
    expect(said()).toContain(MODEL_ANSWER);
    expect(said()).not.toContain('Укажите имя');
  });
});

describe('слово брони во фразе беды заявку не начинает', () => {
  it.each([
    // «подходит» — слово согласия из списка триггеров брони.
    'Медведь подходит к палатке, не уходит',
    // «запишите» — тоже.
    'Запишите координаты: мы заблудились у Горелого',
  ])('«%s» — ответ с 112, черновик не заведён', async (text) => {
    const pending = new Map<number, PendingBooking>();
    await processMessage({ ...base, chatId: CHAT, mode: 'tg', text, pending, platform: 'tg' });
    await settle();

    expect(said()).toContain(SOS_LINE);
    expect(said()).toContain(MODEL_ANSWER);
    expect(said()).not.toContain('Какой тур интересует');
    expect(said()).not.toContain('Как вас зовут');
    expect(pending.has(CHAT)).toBe(false);
    expect(draftWritten()).toBe(false);
  });
});

describe('незаверенный апдейт MAX с живым черновиком', () => {
  it('беда получает блок 112, а не «заявку не оформляю»; в чат ничего не пишется', async () => {
    const pending = new Map([[CHAT, nameStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: 'max', createdVia: 'max', text: 'Помогите, мы заблудились', pending, platform: 'max', verifiedOrigin: false });
    await settle();

    expect(said()).toContain(SOS_LINE);
    expect(said()).toContain(MODEL_ANSWER);
    expect(said()).not.toContain(UNVERIFIED_CHAT_REPLY.booking);
    // Удалить черновик незаверенный не может: записи от него нет.
    expect(chatStateWrites()).toEqual([]);
    expect(pending.has(CHAT)).toBe(true);
  });
});

describe('без беды шаги брони — как раньше (сторож видит шаг брони, если он отвечает)', () => {
  it('имя на шаге «имя» — бот спрашивает дату, черновик жив', async () => {
    const pending = new Map([[CHAT, nameStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: 'tg', text: 'Анна Петрова', pending, platform: 'tg' });
    expect(said()).toContain('Отлично, Анна Петрова!');
    expect(said()).not.toContain('112');
    expect(pending.get(CHAT)?.step).toBe('date');
    expect(tools).not.toHaveBeenCalled();
  });

  it('«нет» на шаге подтверждения — заявка отменена', async () => {
    const pending = new Map([[CHAT, confirmStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: 'max', createdVia: 'max', text: 'нет', pending, platform: 'max', verifiedOrigin: true });
    expect(said()).toContain('Заявка отменена');
    expect(pending.has(CHAT)).toBe(false);
    expect(tools).not.toHaveBeenCalled();
  });

  it('фраза с цифрой на шаге «имя» — просьба указать имя', async () => {
    const pending = new Map([[CHAT, nameStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: 'tg', text: 'Анна 2', pending, platform: 'tg' });
    expect(said()).toContain('Укажите имя');
  });
});

describe('шаг подтверждения: «да» — целым словом, снятый черновик не воскресает', () => {
  it.each([
    'У нас беда',
    'Мы у реки, вода прибывает',
    'Когда нас найдут?',
  ])('«%s» на «Всё верно?» — заявка оператору не уходит', async (text) => {
    const pending = new Map([[CHAT, confirmStep()]]);
    await processMessage({ ...base, chatId: CHAT, mode: 'max', createdVia: 'max', text, pending, platform: 'max', verifiedOrigin: true });
    await settle();
    expect(bookingCreated()).toBe(false);
    expect(said()).not.toContain('Заявка отправлена');
    // Не «да» — шаг переспрашивает, а не отправляет.
    expect(said()).toContain('Напишите <b>Да</b> для подтверждения');
  });

  it('«Да, всё верно» по-прежнему подтверждает', async () => {
    const pending = new Map([[CHAT, confirmStep()]]);
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO operator_bookings/i.test(sql)) return { rows: [{ id: 991 }] };
      return { rows: [] };
    });
    await processMessage({ ...base, chatId: CHAT, mode: 'max', createdVia: 'max', text: 'Да, всё верно', pending, platform: 'max', verifiedOrigin: true });
    await settle();
    expect(said()).not.toContain('Заявка отменена');
    // «Да» узнано: шаг не переспрашивает, а пробует отправить заявку.
    expect(said()).not.toContain('Напишите <b>Да</b> для подтверждения');
    expect(tools).not.toHaveBeenCalled();
  });

  it('база не удалила черновик при беде — следующее «да» его не поднимает из базы', async () => {
    const pending = new Map<number, PendingBooking>();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tg_booking_flow') && /SELECT/.test(sql)) return { rows: [{ state: confirmStep() }] };
      if (sql.includes('DELETE FROM tg_booking_flow')) throw new Error('connection terminated');
      return { rows: [] };
    });
    await processMessage({ ...base, chatId: CHAT + 1, mode: 'tg', text: 'Помогите, мы заблудились', pending, platform: 'tg' });
    await settle();
    reply.mockClear();
    tools.mockClear();
    await processMessage({ ...base, chatId: CHAT + 1, mode: 'tg', text: 'да, ждём у ручья', pending, platform: 'tg' });
    await settle();
    expect(bookingCreated()).toBe(false);
    expect(said()).not.toContain('Заявка отправлена');
    // Ответил Кузьмич, а не шаг брони, поднятый из базы.
    expect(tools).toHaveBeenCalled();
    expect(said()).not.toContain('Не удалось отправить заявку');
  });

  it('голосовое с бедой снимает черновик — следующее «нет» не «отменяет заявку»', async () => {
    const pending = new Map([[CHAT + 2, confirmStep()]]);
    await processMessage({ ...base, chatId: CHAT + 2, mode: 'tg', createdVia: 'tg_voice', text: 'Помогите, мы заблудились', pending, platform: 'tg' });
    await settle();
    expect(pending.has(CHAT + 2)).toBe(false);
    expect(draftDeleted()).toBe(true);
    reply.mockClear();
    await processMessage({ ...base, chatId: CHAT + 2, mode: 'tg', text: 'связи почти нет', pending, platform: 'tg' });
    await settle();
    expect(said()).not.toContain('Заявка отменена');
  });
});
