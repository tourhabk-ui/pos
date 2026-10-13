/**
 * Вопрос человека доходит до модели (13.10, пробы 764–766 через журнал
 * общения A2A).
 *
 * Текстовый путь A2A передавал в цикл инструментов историю прошлых реплик и
 * пустой список новых, а сам вопрос — только аргументом userText, который
 * шёл в сторожа и в базу знаний, но не в сообщения. Модель получала
 * системный промпт с подсказкой и ни одного вопроса: на «какая обстановка у
 * Авачинского вулкана?» отвечала про Ключевскую из тура, потом про
 * Мутновский из маршрутов подсказки. Сломано было с запуска A2A.
 *
 * Сторож — поведением, на настоящем aiChatAgentLoop (подменён только
 * провайдер): что модель получила в сообщениях.
 *  1. A2A (answerAgentMessage) — вопрос последним сообщением человека;
 *  2. цикл сам добавляет вопрос, если вызывающий его не передал;
 *  3. вопрос, уже лежащий в истории (веб-чат, Telegram), не дублируется —
 *     в том числе когда за ним идёт описание фото.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { waterfall } = vi.hoisted(() => ({ waterfall: vi.fn() }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...orig, callToolsWaterfall: (...a: unknown[]) => waterfall(...a) };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { aiChatAgentLoop } from '@/lib/kuzmich/core';
import { answerAgentMessage } from '@/lib/a2a/chat';

type Msg = { role: string; content: string | null };
const QUESTION = 'какая сейчас обстановка у Авачинского вулкана?';

/** Сообщения, которые увидела модель на первом ходе. */
function seen(): Msg[] {
  expect(waterfall).toHaveBeenCalled();
  return waterfall.mock.calls[0]![0] as Msg[];
}
const userTexts = (msgs: Msg[]) => msgs.filter((m) => m.role === 'user').map((m) => m.content);

beforeEach(() => {
  waterfall.mockReset();
  waterfall.mockResolvedValue({ content: 'Авачинский спокоен: зелёный по обеим шкалам.', provider: 'test' });
});

describe('вопрос доходит до модели', () => {
  it('A2A: вопрос агента — последним сообщением человека', async () => {
    const out = await answerAgentMessage(QUESTION, []);
    expect(out.ok).toBe(true);
    const msgs = seen();
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: QUESTION });
    expect(userTexts(msgs).filter((t) => t === QUESTION)).toHaveLength(1);
  });

  it('A2A, второй вопрос в разговоре: история и новый вопрос последним', async () => {
    await answerAgentMessage('а погода там?', [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: 'Авачинский спокоен.' },
    ]);
    const msgs = seen();
    expect(userTexts(msgs)).toEqual([QUESTION, 'а погода там?']);
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'а погода там?' });
  });

  it('цикл сам добавляет вопрос, если вызывающий его не передал', async () => {
    await aiChatAgentLoop(QUESTION, 'система', [], []);
    expect(userTexts(seen())).toEqual([QUESTION]);
  });

  it('вопрос уже в истории (веб-чат, Telegram) — не дублируется, и с описанием фото после него', async () => {
    await aiChatAgentLoop(QUESTION, 'система', [{ role: 'user', content: QUESTION }], []);
    expect(userTexts(seen())).toEqual([QUESTION]);

    waterfall.mockClear();
    const withPhoto = `[Фото: кратер]\n${QUESTION}`;
    await aiChatAgentLoop(withPhoto, 'система', [{ role: 'user', content: withPhoto }], [
      { role: 'user', content: 'Пользователь прислал фото. Вот что на нём: кратер' },
    ]);
    expect(userTexts(seen())).toEqual([withPhoto, 'Пользователь прислал фото. Вот что на нём: кратер']);
  });
});
