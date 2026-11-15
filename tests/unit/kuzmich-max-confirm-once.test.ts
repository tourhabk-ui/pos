/**
 * Сводка перед «Да» в MAX и одно «Да» на одну заявку (#3399, п. 4; слово
 * владельца 15.11 «делай»).
 *
 * Разбор каналов 15.11 нашёл в пошаговой заявке MAX три дыры:
 * - сводка не называла оператора и не говорила, что ему уйдут имя и телефон;
 * - строка согласия обещала «обработку для этой заявки», а записывалось
 *   согласие на передачу туроператору — человек соглашался не на то, что
 *   записано;
 * - черновик, чья отправка не удалась, жил до получаса, и любое «да», «ок»
 *   или «го» отправляло заявку снова без сводки; «да, а сколько стоит?»
 *   тоже отправляло.
 *
 * Сторож — вызов обработчика чата с заверенным апдейтом MAX.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tools, fallback, fast, query, deleteDraft, submit } = vi.hoisted(() => ({
  tools: vi.fn(),
  fallback: vi.fn(),
  fast: vi.fn(),
  query: vi.fn(),
  deleteDraft: vi.fn(),
  submit: vi.fn(),
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

vi.mock('@/lib/kuzmich/chat-request-submit', () => ({ submitChatRequest: (...a: unknown[]) => submit(...a) }));
vi.mock('@/lib/ai/chat-booking-tour', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-booking-tour')>()),
  pickChatBookingTour: vi.fn().mockResolvedValue({
    tour: { id: 36, slug: null, title: 'Мутновский вулкан', base_price: 9000, price_unit: 'per_person', operator_name: 'Тест-Оператор' },
    candidates: [],
  }),
}));

import { processMessage, bookingSummaryText, bookingConsentLine, type PendingBooking } from '@/lib/kuzmich/core';

const reply = vi.fn();
const base = { userName: 'Тест', mode: 'max', createdVia: 'max', reply, platform: 'max' as const, verifiedOrigin: true };

function draft(over: Partial<PendingBooking> = {}): PendingBooking {
  return {
    step: 'confirm',
    started_at: Date.now(),
    tour: { id: 5, title: 'Рыбалка на Быстрой', base_price: 15000, price_unit: 'per_person', operator_id: 'op-1', operator_name: 'Тест-Оператор' } as unknown as PendingBooking['tour'],
    name: 'Тест', phone: '+70000000000', participants: 2, date: '2027-07-20',
    summary_shown: true,
    ...over,
  };
}
const said = (): string => reply.mock.calls.map((c) => String(c[1])).join('\n');

beforeEach(() => {
  for (const f of [tools, fallback, fast, query, deleteDraft, reply, submit]) f.mockReset();
  query.mockResolvedValue({ rows: [] });
  reply.mockResolvedValue(undefined);
  fast.mockResolvedValue('нет');
  fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
  tools.mockResolvedValue({ content: 'ответ', provider: 'test' });
  submit.mockResolvedValue({ ok: true, text: 'Заявка записана.' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('сводка перед «Да»', () => {
  it('называет оператора, тур, дату, людей, цену из базы и какие данные уйдут оператору', () => {
    const text = bookingSummaryText(draft());
    expect(text).toContain('Оператор: <b>Тест-Оператор</b>');
    expect(text).toContain('Тур: <b>Рыбалка на Быстрой</b>');
    expect(text).toContain('Человек: <b>2</b>');
    expect(text).toContain('30');
    expect(text).toContain('Оператору уйдут: имя <b>Тест</b> и телефон <b>+70000000000</b>');
  });

  it('строка согласия говорит о передаче туроператору — как записанная версия', () => {
    expect(bookingConsentLine('Тест-Оператор')).toContain('передачу туроператору «Тест-Оператор»');
    expect(bookingSummaryText(draft())).toContain(bookingConsentLine('Тест-Оператор'));
  });

  it('оператор не записан — так и сказано, а не пустая строка', () => {
    const d = draft();
    (d.tour as unknown as { operator_name: string | null }).operator_name = null;
    expect(bookingSummaryText(d)).toContain('Оператор: не записан');
  });
});

describe('одно «Да» — одна отправка', () => {
  it('телефон — последний шаг: сводка показана, и «да» на неё отправляет с первого раза', async () => {
    const pending = new Map([[77, draft({ step: 'phone', phone: undefined, summary_shown: undefined })]]);
    await processMessage({ ...base, chatId: 77, text: '+70000000000', pending });
    expect(said()).toContain('Проверьте заявку');
    await processMessage({ ...base, chatId: 77, text: 'да', pending });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('«да» на показанную сводку отправляет', async () => {
    const pending = new Map([[77, draft()]]);
    await processMessage({ ...base, chatId: 77, text: 'да', pending });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('отправка не удалась — следующее «ок» показывает сводку снова, а не отправляет', async () => {
    submit.mockResolvedValueOnce({ ok: false, text: 'Не смог подтвердить запись.' });
    const pending = new Map([[77, draft()]]);
    await processMessage({ ...base, chatId: 77, text: 'да', pending });
    expect(submit).toHaveBeenCalledTimes(1);
    reply.mockReset();
    await processMessage({ ...base, chatId: 77, text: 'ок', pending });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(said()).toContain('Проверьте заявку');
    // А «да» на снова показанную сводку — отправляет.
    await processMessage({ ...base, chatId: 77, text: 'да', pending });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('«да, а сколько стоит?» — вопрос, заявка не уходит', async () => {
    const pending = new Map([[77, draft()]]);
    await processMessage({ ...base, chatId: 77, text: 'да, а сколько стоит?', pending });
    expect(submit).not.toHaveBeenCalled();
    expect(said()).toContain('В сообщении вопрос — заявку не отправил');
  });

  it('черновик без поля (до 15.11) — «да» сначала показывает сводку', async () => {
    const pending = new Map([[77, draft({ summary_shown: undefined })]]);
    await processMessage({ ...base, chatId: 77, text: 'да', pending });
    expect(submit).not.toHaveBeenCalled();
    expect(said()).toContain('Оператор: <b>Тест-Оператор</b>');
  });
});

describe('быстрый путь MAX: данные в одной реплике — сводка, заявка следующим «да» (#3399, п. 4)', () => {
  const FULL = 'Хочу на Мутновский 09.11.2099, нас 2 человека, меня зовут Тест, +70000000000, согласен';

  it('реплика с данными — сводка без отправки, «да» — одна отправка', async () => {
    const pending = new Map<number, PendingBooking>();
    await processMessage({ ...base, chatId: 91, text: FULL, pending });
    expect(submit).not.toHaveBeenCalled();
    expect(said()).toContain('Проверьте заявку — она ещё не отправлена');
    expect(said()).toContain('оператор «Тест-Оператор»');
    await processMessage({ ...base, chatId: 91, text: 'да', pending });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({ tool: 'create_booking_request', args: { participants: 2, date: '2099-11-09' } });
    await processMessage({ ...base, chatId: 91, text: 'да', pending });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('«нет» на сводку — заявка не уходит', async () => {
    const pending = new Map<number, PendingBooking>();
    await processMessage({ ...base, chatId: 92, text: FULL, pending });
    await processMessage({ ...base, chatId: 92, text: 'нет', pending });
    expect(submit).not.toHaveBeenCalled();
    expect(said()).toContain('Не отправил');
  });
});
