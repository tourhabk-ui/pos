/**
 * Мозг Кузьмича в MAX: /reset и бронь в чате — только по заверенному апдейту
 * (план мини-приложения, §6.5, этап 0; lib/max/verified-press). Вызовом
 * настоящего processMessage с подменёнными моделью и базой.
 *
 * Вебхук MAX принимает вопросы из любого источника, а в теле апдейта чат —
 * любой. Без гейта поддельный апдейт стирал историю и черновик контроля
 * выхода чужого чата (/reset) или доводил бронь до «да»: бронь оператору и
 * рассылка имени и телефона, которых никто не давал.
 *
 * Что держит:
 *  - незаверенный /reset ничего не удаляет и говорит, что команда не засчитана;
 *  - незаверенное слово брони и незаверенный шаг живой брони не пишут ни в
 *    tg_booking_flow, ни в operator_bookings, ответ — «не оформляю»;
 *  - брошенная бронь (старше 30 минут) не запирает чат: вопрос идёт модели,
 *    как и у заверенного, а сама бронь не трогается — записи от незаверенного
 *    нет;
 *  - вопрос Кузьмичу из незаверенного апдейта доходит до модели и получает
 *    ответ, но ни вопрос, ни ответ, ни заметки памяти не пишутся в чат,
 *    названный телом апдейта (tg_conversations, agent_memory);
 *  - заверенные /reset, бронь и вопрос работают как раньше; /reset стирает и
 *    память чата — то, что туда попало, не переживает очистку;
 *  - Telegram этот гейт не трогает (у него своя проверка вебхука).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tools, fallback, fast, query, deleteDraft } = vi.hoisted(() => ({
  tools: vi.fn(),
  fallback: vi.fn(),
  fast: vi.fn(),
  query: vi.fn(),
  deleteDraft: vi.fn(),
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
// Контроль выхода судится своим сторожем (trip-watch-chat); здесь — только
// то, что /reset зовёт удаление черновика лишь по заверенному апдейту.
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: (...a: unknown[]) => deleteDraft(...a),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));

import { processMessage, type PendingBooking } from '@/lib/kuzmich/core';
import { UNVERIFIED_CHAT_REPLY } from '@/lib/max/verified-press';

const reply = vi.fn();
const base = { userName: 'Анна', mode: 'max', createdVia: 'max', reply };

/** Пишущие запросы, которые ушли в базу. */
const writes = (): string[] =>
  query.mock.calls.map((c) => String(c[0])).filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql));

/** Записи в историю и память чата — то, что войдёт в следующие ответы ему. */
const chatStateWrites = (): string[] =>
  writes().filter((sql) => /tg_conversations|agent_memory|tg_booking_flow/.test(sql));

/** Дать дойти записям «выстрелил и забыл» (память бота, заметки). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Бронь в чате на первом шаге, начатая `agoMs` назад. */
function tourStep(agoMs: number): Map<number, PendingBooking> {
  return new Map([[77, { step: 'tour', started_at: Date.now() - agoMs } as PendingBooking]]);
}

/** Бронь, дошедшая до шага «Всё верно? Да / Нет». */
function confirmStep(): Map<number, PendingBooking> {
  return new Map([[77, {
    step: 'confirm',
    started_at: Date.now(),
    tour: { id: 5, title: 'Рыбалка на Быстрой', base_price: 15000, operator_id: 'op-1' } as unknown as PendingBooking['tour'],
    name: 'Анна Петрова', phone: '+79140000000', participants: 2, date: '2026-11-20',
  }]]);
}

beforeEach(() => {
  for (const f of [tools, fallback, fast, query, deleteDraft, reply]) f.mockReset();
  query.mockResolvedValue({ rows: [] });
  deleteDraft.mockResolvedValue(undefined);
  reply.mockResolvedValue(undefined);
  fast.mockResolvedValue('нет');
  fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
  tools.mockResolvedValue({ content: 'Лучше всего в июле.', provider: 'test' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/reset в MAX', () => {
  it('незаверенный — ничего не удаляет, ответ «не засчитана»', async () => {
    const pending = confirmStep();
    await processMessage({ ...base, chatId: 77, text: '/reset', pending, platform: 'max', verifiedOrigin: false });
    expect(writes()).toEqual([]);
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(pending.has(77)).toBe(true);
    expect(reply.mock.calls).toEqual([[77, UNVERIFIED_CHAT_REPLY.reset]]);
  });

  it('заверенный — история, память чата, бронь в чате и черновик контроля стёрты', async () => {
    await processMessage({ ...base, chatId: 77, text: '/reset', pending: confirmStep(), platform: 'max', verifiedOrigin: true });
    expect(writes().some((sql) => sql.includes('DELETE FROM tg_conversations'))).toBe(true);
    expect(writes().some((sql) => sql.includes('DELETE FROM tg_booking_flow'))).toBe(true);
    const memory = query.mock.calls.find((c) => String(c[0]).includes('DELETE FROM agent_memory'));
    expect(memory?.[1]).toEqual(['kuzmich_mem_max_77']);
    expect(deleteDraft).toHaveBeenCalledWith('max', 77);
    expect(reply).toHaveBeenLastCalledWith(77, 'История очищена. С чего начнём?');
  });
});

describe('бронь в чате MAX', () => {
  it('незаверенное слово брони — бронь не начинается', async () => {
    await processMessage({ ...base, chatId: 77, text: 'бронирую рыбалку', pending: new Map(), platform: 'max', verifiedOrigin: false });
    expect(writes()).toEqual([]);
    expect(tools).not.toHaveBeenCalled();
    expect(reply.mock.calls).toEqual([[77, UNVERIFIED_CHAT_REPLY.booking]]);
  });

  it('незаверенное «да» на шаге подтверждения — брони оператору нет', async () => {
    const pending = confirmStep();
    await processMessage({ ...base, chatId: 77, text: 'да', pending, platform: 'max', verifiedOrigin: false });
    expect(writes()).toEqual([]);
    expect(query.mock.calls.some((c) => String(c[0]).includes('operator_bookings'))).toBe(false);
    expect(reply.mock.calls).toEqual([[77, UNVERIFIED_CHAT_REPLY.booking]]);
  });

  it('заверенное слово брони — бронь начинается, шаг записан', async () => {
    await processMessage({ ...base, chatId: 77, text: 'бронирую', pending: new Map(), platform: 'max', verifiedOrigin: true });
    expect(writes().some((sql) => sql.includes('INSERT INTO tg_booking_flow'))).toBe(true);
    expect(reply.mock.calls.flat().join('\n')).not.toContain('Не смог проверить');
  });

  it('Telegram этот гейт не трогает', async () => {
    await processMessage({ ...base, chatId: 77, text: 'бронирую', pending: new Map(), platform: 'tg' });
    expect(writes().some((sql) => sql.includes('INSERT INTO tg_booking_flow'))).toBe(true);
  });
});

describe('вопрос Кузьмичу из незаверенного апдейта MAX', () => {
  const QUESTION = 'Когда лучше идти на Авачинский вулкан?';

  it('доходит до модели и получает ответ — а в историю и память чата не пишется', async () => {
    // Второе сообщение чата: на чётном счёте заверенный путь синтезирует
    // заметки памяти — здесь не должен ни он, ни простое обновление.
    query.mockImplementation(async (sql: string) =>
      /FROM agent_memory/.test(sql) && /SELECT/.test(sql)
        ? { rows: [{ value: { activities: [], locations: [], travel_style: null, budget_level: null, ai_notes: null, messages_count: 1 } }] }
        : { rows: [] });
    await processMessage({ ...base, chatId: 77, text: QUESTION, pending: new Map(), platform: 'max', verifiedOrigin: false });
    await settle();
    expect(tools).toHaveBeenCalled();
    expect(reply.mock.calls.flat().join('\n')).toContain('Лучше всего в июле.');
    expect(chatStateWrites()).toEqual([]);
    expect(fast).not.toHaveBeenCalled();
    // Вопрос дошёл до модели репликой человека, хотя в историю не записан.
    const sent = tools.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toContain(QUESTION);
  });

  it('запасной путь (цикл инструментов не ответил) тоже получает вопрос — из памяти, не из записанной истории', async () => {
    tools.mockResolvedValue(null);
    await processMessage({ ...base, chatId: 77, text: QUESTION, pending: new Map(), platform: 'max', verifiedOrigin: false });
    await settle();
    expect(fallback).toHaveBeenCalled();
    const fallbackMsgs = fallback.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(fallbackMsgs.filter((m) => m.role === 'user').map((m) => m.content)).toContain(QUESTION);
    expect(reply.mock.calls.flat().join('\n')).toContain('ЗАПАСНОЙ ОТВЕТ');
    expect(chatStateWrites()).toEqual([]);
  });

  it('заверенный вопрос пишется в историю и память, как раньше', async () => {
    await processMessage({ ...base, chatId: 77, text: QUESTION, pending: new Map(), platform: 'max', verifiedOrigin: true });
    await settle();
    expect(chatStateWrites().some((sql) => sql.includes('INSERT INTO tg_conversations'))).toBe(true);
    expect(chatStateWrites().some((sql) => sql.includes('INSERT INTO agent_memory'))).toBe(true);
  });

  it('брошенная бронь (2 ч назад) не запирает чат: вопрос получает ответ модели', async () => {
    const pending = tourStep(2 * 60 * 60 * 1000);
    await processMessage({ ...base, chatId: 77, text: QUESTION, pending, platform: 'max', verifiedOrigin: false });
    await settle();
    const said = reply.mock.calls.flat().join('\n');
    expect(said).toContain('Лучше всего в июле.');
    expect(said).not.toContain(UNVERIFIED_CHAT_REPLY.booking);
    // Брошенную бронь незаверенный апдейт не удаляет: записи от него нет.
    expect(chatStateWrites()).toEqual([]);
  });

  it('то же для заверенного: брошенная бронь удаляется, вопрос — модели', async () => {
    await processMessage({ ...base, chatId: 77, text: QUESTION, pending: tourStep(2 * 60 * 60 * 1000), platform: 'max', verifiedOrigin: true });
    expect(writes().some((sql) => sql.includes('DELETE FROM tg_booking_flow'))).toBe(true);
    expect(reply.mock.calls.flat().join('\n')).toContain('Лучше всего в июле.');
  });

  it('живая бронь — шаг из незаверенного не продвигается', async () => {
    await processMessage({ ...base, chatId: 77, text: 'Рыбалка', pending: tourStep(60 * 1000), platform: 'max', verifiedOrigin: false });
    expect(reply.mock.calls).toEqual([[77, UNVERIFIED_CHAT_REPLY.booking]]);
    expect(chatStateWrites()).toEqual([]);
  });
});
