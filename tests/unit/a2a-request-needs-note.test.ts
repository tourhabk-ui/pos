/**
 * Что понадобится для заявки — агенту заранее, в разговоре текстом (слово
 * владельца 13.11: «как Кузьмич запрашивает согласие, может, согласие не
 * доходит?»).
 *
 * Пробный прогон: о согласии Кузьмич в A2A говорил, а об имени и телефоне —
 * нет, и говорил не каждый раз — это решала модель. Теперь спросили, как
 * забронировать, — в ответе названы имя, телефон и согласие, что бы ни
 * написала модель.
 *
 * Сторож — поведением: правило вызовом и настоящий answerAgentMessage с
 * подменённым провайдером (что ушло агенту).
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

import { answerAgentMessage, A2A_AGENT_NOTE } from '@/lib/a2a/chat';
import { asksHowToRequest, namesAllThree, noteLanguage, requestNeedsNote, REQUEST_NEEDS_NOTE } from '@/lib/a2a/request-needs-note';

beforeEach(() => {
  waterfall.mockReset();
});

describe('правило: когда приписка нужна', () => {
  it.each([
    'Как забронировать тур на Авачинский?',
    'Можно ли оформить заявку на сплав на 5 июля?',
    'Хочу оставить заявку на жильё',
    'Запишите на экскурсию двоих',
    'бронь на вертолёт есть?',
    'How do I book the Avacha tour for two people?',
    'Can you make a reservation for July 5?',
    'I want to place a request for a charter vehicle',
    'Is booking required in advance?',
    '我想预订阿瓦恰火山的旅游团',
    '怎么报名这个行程？',
  ])('вопрос о заявке: %s', (q) => {
    expect(asksHowToRequest(q)).toBe(true);
  });

  it.each([
    'Какая погода на Горелом?',
    'Сколько стоит сплав по Быстрой?',
    'What is the status of Klyuchevskoy volcano?',
    'Is there a guidebook for Kamchatka?',
    '堪察加现在天气怎么样？',
    'Где проходит маршрут на Мутновский?',
  ])('вопрос не о заявке: %s', (q) => {
    expect(asksHowToRequest(q)).toBe(false);
  });

  it('язык приписки — по письменности вопроса', () => {
    expect([noteLanguage('Как забронировать?'), noteLanguage('How to book?'), noteLanguage('怎么预订？'), noteLanguage('预订 Avacha tour')])
      .toEqual(['ru', 'en', 'zh', 'zh']);
  });

  it('ответ уже называет имя, телефон и согласие — приписки нет; не хватает хоть одного — есть', () => {
    const full = 'Понадобятся имя и телефон человека и его согласие на обработку данных.';
    expect(namesAllThree(full)).toBe(true);
    expect(requestNeedsNote('Как забронировать тур?', full)).toBeNull();
    expect(namesAllThree('Нужно согласие человека (consent: true).')).toBe(false);
    expect(requestNeedsNote('Как забронировать тур?', 'Нужно согласие человека (consent: true).')).toBe(REQUEST_NEEDS_NOTE.ru);
    expect(requestNeedsNote('How do I book?', 'Call create_booking_request.')).toBe(REQUEST_NEEDS_NOTE.en);
    expect(requestNeedsNote('怎么预订？', '请调用 create_booking_request。')).toBe(REQUEST_NEEDS_NOTE.zh);
    expect(requestNeedsNote('Какая погода?', 'Ясно.')).toBeNull();
    // Английский и китайский ответ с тремя вещами тоже узнаются.
    expect(namesAllThree('You will need the name, phone and consent of the person.')).toBe(true);
    expect(namesAllThree('需要姓名、电话和当事人的同意。')).toBe(true);
  });

  it('каждая приписка называет все три вещи и consent: true', () => {
    for (const text of Object.values(REQUEST_NEEDS_NOTE)) {
      expect(namesAllThree(text)).toBe(true);
      expect(text).toContain('consent: true');
    }
  });
});

describe('ответ агенту в A2A', () => {
  it('спросили, как забронировать, а модель про имя и телефон промолчала — они названы в ответе', async () => {
    waterfall.mockResolvedValue({ content: 'Заявку агент создаёт сам вызовом create_booking_request.', provider: 'test' });
    const out = await answerAgentMessage('Как забронировать тур на Авачинский на 5 июля?', []);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('create_booking_request');
    expect(out.text.endsWith(REQUEST_NEEDS_NOTE.ru)).toBe(true);
  });

  it('английский и китайский вопрос — приписка на языке вопроса', async () => {
    waterfall.mockResolvedValue({ content: 'Use the create_booking_request tool.', provider: 'test' });
    expect((await answerAgentMessage('How do I book the Avacha tour?', [])).text.endsWith(REQUEST_NEEDS_NOTE.en)).toBe(true);
    waterfall.mockResolvedValue({ content: '请调用 create_booking_request 工具。', provider: 'test' });
    expect((await answerAgentMessage('我想预订阿瓦恰火山的旅游团', [])).text.endsWith(REQUEST_NEEDS_NOTE.zh)).toBe(true);
  });

  it('модель сама назвала имя, телефон и согласие — приписка не дублирует', async () => {
    waterfall.mockResolvedValue({ content: 'Для заявки спросите у человека имя, телефон и согласие на обработку данных, затем вызовите create_booking_request.', provider: 'test' });
    const out = await answerAgentMessage('Как забронировать тур?', []);
    expect(out.text).not.toContain(REQUEST_NEEDS_NOTE.ru);
  });

  it('вопрос не о заявке — ответ без приписки', async () => {
    waterfall.mockResolvedValue({ content: 'На Горелом ясно, ветер слабый.', provider: 'test' });
    const out = await answerAgentMessage('Какая погода на Горелом?', []);
    expect(out.ok).toBe(true);
    for (const text of Object.values(REQUEST_NEEDS_NOTE)) expect(out.text).not.toContain(text);
  });

  it('подсказка модели тоже называет имя и телефон, а не одно согласие', () => {
    expect(namesAllThree(A2A_AGENT_NOTE)).toBe(true);
  });
});
