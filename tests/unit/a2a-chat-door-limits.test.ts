/**
 * Пределы свободного разговора чужого агента по A2A — вход (app/api/a2a/_shared).
 *
 * Проверка безопасности ИИ-части 26.11 (слово владельца «чини Карт бланш»):
 * у разговора был только предел 10 вопросов в минуту с адреса. Один анонимный
 * агент за минуты доводил траты до общего суточного стопа, и Кузьмич замолкал
 * для всех — на сайте, в Telegram и MAX.
 *
 * Здесь — вызов исполнителя разговора (`buildExecutors().chat`) с подменённым
 * ответом Кузьмича: дневной предел на адрес, своя доля бюджета, вопрос о беде
 * мимо пределов. Размер вопроса и история — tests/unit/a2a-chat-limits.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { answerAgentMessage, spent } = vi.hoisted(() => ({
  answerAgentMessage: vi.fn(async () => ({ ok: true as const, text: 'ответ' })),
  spent: { usd: 0 },
}));
vi.mock('@/lib/a2a/chat', async (orig) => ({
  ...(await orig<typeof import('@/lib/a2a/chat')>()),
  answerAgentMessage,
}));
vi.mock('@/lib/a2a/dialog-log', () => ({ logA2aDialog: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ spent: String(spent.usd) }] })) },
}));

import { buildExecutors } from '@/app/api/a2a/_shared';
import { A2A_IP_DAILY_LIMIT_TEXT, A2A_DOORS_STOP_TEXT } from '@/lib/a2a/chat';
import { a2aChatGuard, anonChatGuard, A2A_PER_IP_DAILY, ANON_DOORS_BUDGET_SHARE } from '@/lib/ai/anon-chat-guard';

const request = (ip: string) => new NextRequest('https://vedarai.ru/api/a2a', { method: 'POST', headers: { 'x-real-ip': ip } });
const ask = (ip: string, text = 'какие туры на Авачинский?') => buildExecutors(request(ip)).chat(text, [], 'ctx-1');

beforeEach(() => {
  answerAgentMessage.mockClear();
  a2aChatGuard.reset();
  anonChatGuard.reset();
  spent.usd = 0;
  vi.stubEnv('AI_DAILY_BUDGET_USD', '5');
});

describe('разговор агента: сутки на адрес', () => {
  it(`после ${A2A_PER_IP_DAILY} вопросов с адреса за сутки — отказ без модели, код daily_limit; другой адрес отвечает`, async () => {
    for (let i = 0; i < A2A_PER_IP_DAILY; i++) a2aChatGuard.takeIpSlot('203.0.113.5');
    const out = await ask('203.0.113.5');
    expect(out).toEqual({ ok: false, text: A2A_IP_DAILY_LIMIT_TEXT, rejected: true, reason: 'daily_limit' });
    expect(answerAgentMessage).not.toHaveBeenCalled();
    expect((await ask('203.0.113.6')).ok).toBe(true);
    expect(answerAgentMessage).toHaveBeenCalledTimes(1);
  });

  it('вопрос о беде идёт мимо предела адреса', async () => {
    for (let i = 0; i < A2A_PER_IP_DAILY; i++) a2aChatGuard.takeIpSlot('203.0.113.7');
    const out = await ask('203.0.113.7', 'помогите, у друга перелом ноги на склоне');
    expect(out.ok).toBe(true);
    expect(answerAgentMessage).toHaveBeenCalledTimes(1);
  });

  it('каждый ответ занимает место адреса', async () => {
    await ask('203.0.113.8');
    for (let i = 1; i < A2A_PER_IP_DAILY; i++) expect(a2aChatGuard.takeIpSlot('203.0.113.8')).toBe(true);
    expect(a2aChatGuard.takeIpSlot('203.0.113.8')).toBe(false);
  });
});

describe('разговор агента: своя доля бюджета', () => {
  it('траты сайта дошли до доли бюджета — агент получает стоп, а гость сайта ещё нет', async () => {
    spent.usd = 5 * ANON_DOORS_BUDGET_SHARE;
    const out = await ask('203.0.113.9');
    expect(out).toEqual({ ok: true, text: A2A_DOORS_STOP_TEXT });
    expect(answerAgentMessage).not.toHaveBeenCalled();
    expect(await anonChatGuard.dailyStopped()).toBe(false);
  });

  it('ниже доли — отвечает как обычно', async () => {
    spent.usd = 5 * ANON_DOORS_BUDGET_SHARE - 0.01;
    expect((await ask('203.0.113.10')).ok).toBe(true);
  });

  it('доля — половина, а стоп текстом называет 112 и инструменты без предела', () => {
    expect(ANON_DOORS_BUDGET_SHARE).toBe(0.5);
    expect(A2A_DOORS_STOP_TEXT).toMatch(/112/);
    expect(A2A_DOORS_STOP_TEXT).toMatch(/DataPart, MCP/);
    expect(A2A_IP_DAILY_LIMIT_TEXT).toMatch(/112/);
  });
});
