// @vitest-environment node
/**
 * Граница ПД на пути «опиши поездку» (аудит планировщика 07.11, находка Б29).
 *
 * Публичный POST /api/planner/chat отдавал свободный текст человека в
 * зарубежную модель как есть: вписал человек «звоните +7…» или почту — они
 * уходили за границу без согласия на такую передачу. Кузьмич тот же текст
 * чистит (redactUserTurns), а гард D1 этот путь не видит по построению: он
 * судит имена полей (`.phone`, `.email`), а здесь поле называется `message`.
 *
 * Сторож — вызовом роута с подменённой моделью: что увидела модель и что
 * вернул разбор. Чистится только реплика для модели; запасной разбор по словам
 * в сеть не ходит и читает сырой текст — номер, записанный с пробелами, чистка
 * вырезает вместе с числами рядом.
 *
 * Ревью безопасности #3204 (10.11): первая редакция сторожа стояла ровно на
 * границе прежней чистки — 15 цифр. Одна цифра рядом («+7… 10-14 2 дня»), и
 * номер уходил модели дословно. Случаи ниже — с числами вокруг номера.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

type Msg = { role: string; content: string };
const sent: Msg[][] = [];
let modelReply = '';
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(async (messages: Msg[]) => { sent.push(messages); return modelReply; }),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { POST } from '@/app/api/planner/chat/route';

const PHONE = '+70000000000';
const EMAIL = 'test@example.com';
const ask = (message: string, ip: string) => POST(new NextRequest('http://localhost/api/planner/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ message }),
}));
const userTurn = (): string => sent[0]?.find((m) => m.role === 'user')?.content ?? '';
const digits = (s: string) => s.replace(/\D/g, '');

describe('«опиши поездку»: телефон и почта до модели не доходят', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T03:00:00Z'));
    sent.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('в модель ушёл текст без телефона и почты, а места и даты разобраны', async () => {
    modelReply = '{"places":["volcano"],"activities":["fishing"],"arrival":"2027-07-10","departure":"2027-07-14","duration_days":null}';
    const res = await ask(`вулканы и рыбалка с 10 по 14 июля, 2 дня отдыха. Я Тест, телефон ${PHONE}, почта ${EMAIL}`, '10.9.0.1');
    const body = await res.json() as Record<string, unknown>;
    expect(sent).toHaveLength(1);
    const all = sent[0]!.map((m) => m.content).join('\n');
    expect(all).not.toContain(EMAIL);
    expect(digits(all)).not.toContain(digits(PHONE));
    // То, что модели нужно для разбора, осталось.
    expect(userTurn()).toContain('вулканы и рыбалка с 10 по 14 июля');
    expect(body).toMatchObject({
      success: true, places: ['volcano'], activities: ['fishing'],
      arrival: '2027-07-10', departure: '2027-07-14', rest_days: 2,
    });
    // И наружу, в ответ формы, они не возвращаются.
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(digits(JSON.stringify(body))).not.toContain(digits(PHONE));
  });

  it.each([
    // [что написал человек, что из этого модель обязана увидеть]
    [`рыбалка, звоните ${PHONE} 10-14 июля`, '10-14 июля'],
    [`рыбалка, звоните ${PHONE} 10-14 2 дня отдыха`, '10-14 2 дня отдыха'],
    [`рыбалка, звоните 80000000000 10000 рублей`, '10000 рублей'],
    [`рыбалка 10-14 июля, бюджет 150000-200000 ${PHONE}`, 'бюджет 150000-200000'],
  ])('номер рядом с датой, сроком и бюджетом до модели не доходит, а числа рядом — доходят: %s', async (message, kept) => {
    modelReply = '';
    await ask(message, `10.9.1.${message.length % 250}`);
    expect(digits(userTurn())).not.toContain('0000000000');
    expect(userTurn()).toContain('[телефон]');
    expect(userTurn()).toContain(kept);
  });

  it('номер, записанный с пробелами, вырезается вместе с числами рядом; запасной разбор читает сырой текст, ему это не мешает', async () => {
    modelReply = '';
    const res = await ask('рыбалка, звоните 8 900 000 00 00 10-14 июля', '10.9.0.2');
    const body = await res.json() as { activities: string[]; arrival: string; departure: string };
    expect(digits(userTurn())).toBe('');
    expect(userTurn()).toBe('рыбалка, звоните [телефон] июля');
    expect(body.activities).toContain('fishing');
    expect([body.arrival, body.departure]).toEqual(['2027-07-10', '2027-07-14']);
  });

  it('текст без личных данных уходит в модель как есть', async () => {
    modelReply = '';
    await ask('вулканы и горячие источники на неделю в августе', '10.9.0.3');
    expect(userTurn()).toBe('вулканы и горячие источники на неделю в августе');
  });
});
