/**
 * Граница ПД перед зарубежной моделью в чате Кузьмича (аудит 15.10, W2-5).
 *
 * До правки текст туриста уходил в модель как есть: вопрос добавлялся в
 * сообщения цикла без чистки, а redactPII стоял только перед веб-поиском.
 * Политика при этом обещала, что телефон во внешний сервис не передаётся.
 *
 * Сторож — поведением, на настоящем коде (подменены только провайдеры и
 * база): что увидела модель.
 *  1. Цикл инструментов (через него идут веб, Telegram, MAX, A2A): ни телефон,
 *     ни почта из вопроса и истории до модели не дошли; системный промпт с
 *     телефоном МЧС не тронут — граница режет только реплики человека.
 *  2. Telegram целиком (processMessage → aiChat): и цикл, и запасной водопад.
 *  3. Шаг брони читает телефон из СЫРОГО текста — до границы: заявка его
 *     получает, модель не зовётся вовсе.
 *  4. Прочие двери с текстом туриста: запасной путь веб-чата
 *     (buildMessageHistory), сжатие истории, окно чата на сайте партнёра.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tools, waterfall, fast, history } = vi.hoisted(() => ({
  tools: vi.fn(),
  waterfall: vi.fn(),
  fast: vi.fn(),
  /** Что вернёт база на чтение истории Telegram — как будто сообщение уже сохранено. */
  history: { rows: [] as Array<{ role: string; content: string }> },
}));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...orig,
    callToolsWaterfall: (...a: unknown[]) => tools(...a),
    callAIWaterfallDetailed: (...a: unknown[]) => waterfall(...a),
    callAIFast: (...a: unknown[]) => fast(...a),
  };
});
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => (
      /FROM tg_conversations/.test(sql) && /ORDER BY created_at DESC/.test(sql)
        ? { rows: [...history.rows].reverse() }
        : { rows: [] }
    )),
  },
}));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/route-knowledge', () => ({ searchRoutes: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', () => ({ searchOperatorAvailability: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>();
  return { ...orig, gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined) };
});

import { aiChatAgentLoop, processMessage, type PendingBooking } from '@/lib/kuzmich/core';
import { buildMessageHistory } from '@/lib/ai/prompts';
import { summarizeDroppedTurns } from '@/lib/kuzmich/history-compaction';
import { widgetUserContent } from '@/lib/embed/widget-chat';

const PHONE = '+7 914 123-45-67';
const EMAIL = 'ivan.petrov@mail.ru';
const MCHS = '+7 (4152) 41-23-18';
const QUESTION = `Как добраться до Авачинского вулкана? Мой телефон ${PHONE}, почта ${EMAIL}`;

type Msg = { role: string; content: string | null };

/** Всё, что ушло в модель, одной строкой. */
function sentText(calls: unknown[][]): string {
  return calls.flatMap((c) => (c[0] as Msg[]).map((m) => m.content ?? '')).join('\n');
}

/** Ни телефона, ни почты — ни в каком написании. */
function expectNoPII(text: string): void {
  expect(text).not.toContain(EMAIL);
  expect(text.replace(/\D/g, '')).not.toContain('9141234567');
}

beforeEach(() => {
  tools.mockReset();
  waterfall.mockReset();
  fast.mockReset();
  tools.mockResolvedValue({ content: 'До Авачинского — от Петропавловска по дороге на Авачинский перевал.', provider: 'test' });
  waterfall.mockResolvedValue({ text: 'До Авачинского — по дороге на перевал.', provider: 'test' });
  fast.mockResolvedValue('нет');
});

describe('цикл инструментов: реплики человека до модели без телефона и почты', () => {
  it('вопрос, история и описание фото — очищены; системный промпт не тронут', async () => {
    await aiChatAgentLoop(
      QUESTION,
      `Система. Телефон МЧС для туристов: ${MCHS}`,
      [
        { role: 'user', content: `Прошлый раз писал: звоните ${PHONE}` },
        { role: 'assistant', content: 'Понял, расскажу про маршрут.' },
      ],
      [{ role: 'user', content: `Пользователь прислал фото. Вот что на нём: визитка ${EMAIL}` }],
    );
    const msgs = tools.mock.calls[0]![0] as Msg[];
    const human = msgs.filter((m) => m.role === 'user').map((m) => m.content ?? '').join('\n');
    expectNoPII(human);
    expect(human).toContain('[телефон]');
    expect(human).toContain('[email]');
    // Вопрос дошёл — очищенным, и только один раз.
    expect(msgs.filter((m) => m.role === 'user' && (m.content ?? '').startsWith('Как добраться до Авачинского вулкана?'))).toHaveLength(1);
    // Данные платформы человеку нужны: телефон МЧС в системном промпте остаётся.
    expect(msgs[0]).toEqual({ role: 'system', content: `Система. Телефон МЧС для туристов: ${MCHS}` });
  });

  // Ревью A20: граница режет телефон, а не всё с цифрами. Даты поездки нужны
  // инструментам занятости, координаты — инструменту погоды («из вопроса
  // человека»), бюджет — подбору.
  it('даты, координаты и бюджет доходят до модели как есть, телефон в той же реплике — нет', async () => {
    const FACTS = ['10-15.08.2026', '53.2551 158.8432', '150000-200000', '150 000 - 200 000 руб'];
    const question = `Едем ${FACTS[0]}, стоим на ${FACTS[1]}, бюджет ${FACTS[2]} или ${FACTS[3]}. Мой телефон ${PHONE}`;
    await aiChatAgentLoop(question, 'система', [], []);
    const msgs = tools.mock.calls[0]![0] as Msg[];
    const human = msgs.filter((m) => m.role === 'user').map((m) => m.content ?? '').join('\n');
    for (const fact of FACTS) expect(human).toContain(fact);
    expectNoPII(human);
    expect(human).toContain('Мой телефон [телефон]');
  });

  it('вопрос уже в истории (веб-чат) — не дублируется и после чистки', async () => {
    await aiChatAgentLoop(QUESTION, 'система', [{ role: 'user', content: QUESTION }], []);
    const msgs = tools.mock.calls[0]![0] as Msg[];
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
    expectNoPII(sentText(tools.mock.calls));
  });
});

describe('Telegram целиком: processMessage → aiChat', () => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const base = { userName: 'Иван', mode: 'kuzmich', createdVia: 'telegram_kuzmich', reply, platform: 'tg' as const };

  beforeEach(() => {
    reply.mockClear();
    // aiChat сохраняет сообщение и читает историю из базы: вопрос туриста
    // приходит в модель именно оттуда, сырым — как лежит в tg_conversations.
    history.rows = [{ role: 'user', content: QUESTION }];
  });

  it('цикл инструментов не видит телефон и почту туриста', async () => {
    await processMessage({ ...base, chatId: 101, text: QUESTION, pending: new Map() });
    expect(tools).toHaveBeenCalled();
    expectNoPII(sentText(tools.mock.calls));
    expect(reply).toHaveBeenCalled();
  });

  it('цикл не ответил — запасной водопад тоже без телефона и почты', async () => {
    tools.mockResolvedValue(null);
    await processMessage({ ...base, chatId: 102, text: QUESTION, pending: new Map() });
    expect(waterfall).toHaveBeenCalled();
    expectNoPII(sentText(waterfall.mock.calls));
    expect(sentText(waterfall.mock.calls)).toContain('[телефон]');
  });

  it('шаг брони получает телефон из сырого текста, модель не зовётся', async () => {
    const pending = new Map<number, PendingBooking>();
    pending.set(103, {
      step: 'phone',
      tour: { id: 7, title: 'Восхождение на Авачинский', base_price: 9000 },
      date: '2027-07-15',
      participants: 2,
      name: 'Иван Петров',
      started_at: Date.now(),
    } as unknown as PendingBooking);
    await processMessage({ ...base, chatId: 103, text: PHONE, pending });

    expect(tools).not.toHaveBeenCalled();
    expect(waterfall).not.toHaveBeenCalled();
    expect(pending.get(103)).toMatchObject({ step: 'confirm', phone: '+79141234567' });
    const confirm = String(reply.mock.calls.at(-1)?.[1] ?? '');
    expect(confirm).toContain('+79141234567');
  });
});

describe('прочие двери с текстом туриста — та же граница', () => {
  it('запасной путь веб-чата: реплика человека очищена, ответ помощника как есть', () => {
    const msgs = buildMessageHistory('система', [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: `Звоните в МЧС: ${MCHS}` },
    ], 10);
    expectNoPII(msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n'));
    expect(msgs.find((m) => m.role === 'assistant')?.content).toBe(`Звоните в МЧС: ${MCHS}`);
  });

  it('сжатие отброшенной истории уходит в модель без телефона и почты', async () => {
    await summarizeDroppedTurns([
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: 'Расскажу про маршрут.' },
    ]);
    expect(fast).toHaveBeenCalledTimes(1);
    expectNoPII(sentText(fast.mock.calls));
  });

  it('окно чата на сайте партнёра: всё, что прислал браузер, — без телефона и почты', () => {
    const content = widgetUserContent(
      [{ role: 'user', content: `Мой номер ${PHONE}` }, { role: 'assistant', content: `Пишите на ${EMAIL}` }],
      QUESTION,
    );
    expectNoPII(content);
    expect(content).toContain('Как добраться до Авачинского вулкана?');
    expectNoPII(widgetUserContent([], QUESTION));
  });
});
