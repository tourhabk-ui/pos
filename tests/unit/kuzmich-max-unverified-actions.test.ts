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
 *  - незаверенный /reset ничего не удаляет и отвечает «не смог проверить»;
 *  - незаверенное слово брони и незаверенный шаг уже начатой брони не пишут
 *    ни в tg_booking_flow, ни в operator_bookings, ответ — «не смог проверить»;
 *  - заверенные /reset и бронь работают как раньше;
 *  - вопрос Кузьмичу из незаверенного апдейта доходит до модели;
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
  it('незаверенный — ничего не удаляет, ответ «не смог проверить»', async () => {
    const pending = confirmStep();
    await processMessage({ ...base, chatId: 77, text: '/reset', pending, platform: 'max', verifiedOrigin: false });
    expect(writes()).toEqual([]);
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(pending.has(77)).toBe(true);
    expect(reply.mock.calls).toEqual([[77, UNVERIFIED_CHAT_REPLY.reset]]);
  });

  it('заверенный — история, бронь в чате и черновик контроля стёрты', async () => {
    await processMessage({ ...base, chatId: 77, text: '/reset', pending: confirmStep(), platform: 'max', verifiedOrigin: true });
    expect(writes().some((sql) => sql.includes('DELETE FROM tg_conversations'))).toBe(true);
    expect(writes().some((sql) => sql.includes('DELETE FROM tg_booking_flow'))).toBe(true);
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
  it('доходит до модели и получает ответ', async () => {
    await processMessage({ ...base, chatId: 77, text: 'Когда лучше идти на Авачинский вулкан?', pending: new Map(), platform: 'max', verifiedOrigin: false });
    expect(tools).toHaveBeenCalled();
    expect(reply.mock.calls.flat().join('\n')).toContain('Лучше всего в июле.');
  });
});
