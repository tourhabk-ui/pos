/**
 * Кузьмич не отчитывается о доставке, которой не делал (15.10).
 *
 * Снимок владельца 15.10: внешний агент по A2A спросил «проверка доставки
 * сообщения в MAX через Кузьмича, всё ли дошло?», Кузьмич ответил «Сообщение
 * дошло, связка работает» — без единого инструмента. Отправлять ему нечем:
 * в KUZMICH_TOOLS нет инструмента заявки; заявка идёт через create_lead и
 * родню другим путём. Самоотчёт о действии, которого не было (§8).
 *
 * Сторож — вызов чистой функции на граничных текстах и вызов настоящего
 * aiChatAgentLoop через A2A с подменённым провайдером: что уйдёт агенту.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  guardDeliveryClaims, findDeliveryClaims, DELIVERY_HONEST_LINE, DELIVERY_TOOLS,
} from '@/lib/kuzmich/delivery-claim-guard';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import type { ToolRun } from '@/lib/agents/eval/grounding';

const { waterfall } = vi.hoisted(() => ({ waterfall: vi.fn() }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...orig, callToolsWaterfall: (...a: unknown[]) => waterfall(...a) };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { answerAgentMessage } from '@/lib/a2a/chat';

const GROK_ANSWER = 'Привет, Grok. Сообщение дошло, связка работает. Я Кузьмич, Хранитель Камчатки на платформе Ведар.\n\nЕсли Андрею нужно что-то проверить по турам — спрашивай.';

describe('утверждения о доставке без инструмента заявки', () => {
  it('«дошло, связка работает» без инструментов — предложение заменено честной строкой, остальное цело', () => {
    const g = guardDeliveryClaims(GROK_ANSWER, []);
    expect(g.verdict).toBe('unbacked');
    expect(g.text).not.toMatch(/дошло|связка работает/);
    expect(g.text).toContain(DELIVERY_HONEST_LINE);
    expect(g.text).toContain('Привет, Grok.');
    expect(g.text).toContain('Я Кузьмич, Хранитель Камчатки');
    expect(g.text).toContain('Если Андрею нужно что-то проверить');
    expect(g.removed).toEqual(['Сообщение дошло, связка работает.']);
  });

  it('запасной путь без инструментов (null) — то же, что пустой журнал', () => {
    expect(guardDeliveryClaims('Заявка отправлена оператору, ждите ответа.', null).verdict).toBe('unbacked');
  });

  it('инструмент заявки с данными в этом ходе — опора есть, текст не тронут', () => {
    const runs: ToolRun[] = [{ name: 'create_booking_request', producedData: true, output: 'Заявка принята, ключ статуса …' }];
    const g = guardDeliveryClaims('Заявка отправлена оператору, ответ придёт в чат.', runs);
    expect(g.verdict).toBe('backed');
    expect(g.text).toBe('Заявка отправлена оператору, ответ придёт в чат.');
  });

  it('инструмент заявки, не принёсший данных, опорой не считается', () => {
    const runs: ToolRun[] = [{ name: 'create_lead', producedData: false, output: 'Не удалось записать заявку.' }];
    expect(guardDeliveryClaims('Заявка передана оператору.', runs).verdict).toBe('unbacked');
  });

  it('инструмент места — не доставка: «дошло» после get_guardian_context остаётся без опоры', () => {
    const runs: ToolRun[] = [{ name: 'get_guardian_context', producedData: true, output: 'Вулкан Авачинский [ЗЕЛЁНЫЙ]' }];
    expect(guardDeliveryClaims('Сообщение дошло.', runs).verdict).toBe('unbacked');
  });

  it('под отрицанием — не утверждение: «сообщения операторам я не отправляю» не трогается', () => {
    const honest = 'Сам я сообщения операторам не отправляю. Заявка не доставлена, пока ты не подтвердишь её.';
    const g = guardDeliveryClaims(honest, []);
    expect(g.verdict).toBe('none');
    expect(g.text).toBe(honest);
  });

  it('текст без слов о доставке — none и без изменений', () => {
    const plain = 'Авачинский спокоен: статус зелёный, регистрация в МЧС обязательна.';
    expect(guardDeliveryClaims(plain, [])).toEqual({ text: plain, verdict: 'none', removed: [], phrases: [] });
  });

  it('ловится и «оператор уведомлён», и «заявка ушла», и «доставлено»; «дошли до перевала» — нет', () => {
    expect(findDeliveryClaims('Оператор уведомлён, заявка ушла.')).toHaveLength(2);
    expect(findDeliveryClaims('Доставлено.')).toHaveLength(1);
    // «дошли» в смысле «добрались» ловится тоже — по форме не отличить; цена —
    // лишняя поправка в редком рассказе о походе, а не ложь о заявке.
    expect(findDeliveryClaims('Мы дошли до перевала к полудню.')).toHaveLength(1);
  });
});

describe('в цикле Кузьмича нет инструмента доставки — «дошло» не может иметь опоры', () => {
  it('KUZMICH_TOOLS не содержит ни одного из DELIVERY_TOOLS', () => {
    const names = KUZMICH_TOOLS.map((t) => t.function.name);
    for (const d of DELIVERY_TOOLS) expect(names).not.toContain(d);
  });
});

describe('A2A: ответ внешнему агенту проходит сторож доставки', () => {
  beforeEach(() => {
    waterfall.mockReset();
    waterfall.mockResolvedValue({ content: GROK_ANSWER, provider: 'test' });
  });

  it('«сообщение дошло» от модели не доходит до агента; честная строка — доходит', async () => {
    const out = await answerAgentMessage('Тестовое сообщение от Grok через Ведар в MAX для местечка Камчатка. Всё ли дошло?', []);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).not.toMatch(/дошло|связка работает/);
    expect(out.text).toContain(DELIVERY_HONEST_LINE);
    expect(out.text).toContain('Я Кузьмич');
  });
});
