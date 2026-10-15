/**
 * Чат виджета пишет, откуда пришёл человек (аудит 15.10, находка
 * WID-measure, W5) — вызовом POST /api/widget/chat.
 *
 * До 15.10 чат записывал `domain: origin` — Origin запроса, а запрос идёт из
 * iframe с vedarai.ru, так что там всегда стоял наш собственный адрес. Теперь
 * окно чата присылает хост и путь страницы партнёра (их кладёт embed.js в
 * адрес окна), сервер сверяет хост со списком доменов партнёра и пишет в
 * chat_sessions.widget_origin один из трёх исходов: listed / unlisted /
 * not_sent. Хост подделывается — сигнал для счёта, а не замок: ответ чата от
 * исхода не зависит (проверено ниже).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ query: vi.fn(), ai: vi.fn(), safety: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: m.query }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
// Модель — водопадом (WID-safety); пул, сводка обстановки и журнал проверок
// безопасности — моки: здесь судится только запись происхождения разговора.
vi.mock('@/lib/ai/providers', () => ({ callAIWaterfallOrNull: m.ai }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn(async () => '') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/safety/current-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/current-status')>()),
  getCurrentSafetyStatus: m.safety,
}));

import { POST } from '@/app/api/widget/chat/route';
import { WIDGET_CHAT_SESSION_SQL } from '@/lib/embed/widget-telemetry';

const PARTNER = {
  id: 'op-mestechko', name: 'Местечко Камчатка', category: 'operator', description: null,
  widget_config: {}, widget_domains: ['mestechkokam.ru'],
};

let ipSeq = 0;
async function ask(origin?: unknown, extra: Record<string, unknown> = {}) {
  ipSeq += 1;
  const res = await POST(new NextRequest('https://vedarai.ru/api/widget/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.6.0.${ipSeq}`, origin: 'https://vedarai.ru' },
    body: JSON.stringify({
      partnerId: 'mestechko', sessionId: `w_${ipSeq}`, message: 'Когда лучше лететь на вертолёте?',
      ...(origin === undefined ? {} : { origin }),
      ...extra,
    }),
  }));
  return res;
}

/** Параметры записи разговора в chat_sessions. */
function savedParams(): unknown[] {
  const call = m.query.mock.calls.find((c) => c[0] === WIDGET_CHAT_SESSION_SQL);
  expect(call, 'разговор не записан в chat_sessions').toBeTruthy();
  return call![1] as unknown[];
}

function savedOrigin(): unknown {
  return JSON.parse(String(savedParams()[2]));
}

beforeEach(() => {
  m.query.mockReset();
  m.ai.mockReset();
  m.ai.mockResolvedValue('Лучше в ясную погоду.');
  m.safety.mockReset();
  m.safety.mockResolvedValue({
    hasAlert: false, maxSeverity: 0, activeCount: 0, topTitle: null, topType: null,
    dataUpdatedAt: null, source: 'ленты МЧС', feedCount: 0, feedTitles: [], feedBasis: [], feedWhen: [], outsideFeed: null,
  });
  m.query.mockImplementation(async (sql: string) =>
    /FROM partners/.test(sql) ? { rows: [PARTNER] } : { rows: [], rowCount: 1 });
});

describe('chat_sessions.widget_origin — три исхода', () => {
  it('хост из списка партнёра — listed; путь без query', async () => {
    const res = await ask({ host: 'mestechkokam.ru', path: '/tury/?phone=79001234567' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(savedOrigin()).toEqual({ host: 'mestechkokam.ru', path: '/tury/', host_check: 'listed' }));
  });

  it('чужой хост — unlisted, а ответ чата тот же (сигнал, не замок)', async () => {
    const res = await ask({ host: 'evil.example', path: '/' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.answer).toBe('Лучше в ясную погоду.');
    await vi.waitFor(() => expect(savedOrigin()).toMatchObject({ host: 'evil.example', host_check: 'unlisted' }));
  });

  it('хост не прислан (старое окно) — not_sent', async () => {
    await ask();
    await vi.waitFor(() => expect(savedOrigin()).toEqual({ host: null, path: null, host_check: 'not_sent' }));
  });

  it('Origin запроса (vedarai.ru) за хост партнёра не выдаётся', async () => {
    await ask({ host: null, path: null });
    await vi.waitFor(() => expect(savedOrigin()).toMatchObject({ host: null, host_check: 'not_sent' }));
  });

  it('разговор не записался — ответ уходит, отказ в логе с SQLSTATE', async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (/FROM partners/.test(sql)) return { rows: [PARTNER] };
      throw Object.assign(new Error('column "widget_origin" does not exist'), { code: '42703' });
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await ask({ host: 'mestechkokam.ru', path: '/' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(err.mock.calls.flat().join(' ')).toMatch(/SQLSTATE=42703/));
    err.mockRestore();
  });
});

describe('chat_sessions.user_message_count — считает сервер, а не присланная история (аудит 15.10, R-chat)', () => {
  // Окно присылает историю урезанной (20 реплик, 12 000 знаков), и счёт по
  // ней занижал разговорную активность в переписи widget-census; выдуманная
  // история его накручивала. Счёт ведёт SQL записи (+1 к записанному) —
  // его поведение на настоящем PostgreSQL держит widget-measure.pg.test.ts.
  it('20 выдуманных «реплик человека» в истории — в запись не уходит ни одно число из запроса', async () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `реплика ${i + 1}` }));
    const res = await ask({ host: 'mestechkokam.ru', path: '/' }, { history });
    expect(res.status).toBe(200);
    const params = await vi.waitFor(() => savedParams());
    expect(params.filter((p) => typeof p === 'number')).toEqual([]);
    expect(params).not.toContain(21);
    // Сами реплики разговор по-прежнему хранит — последние 20.
    expect(JSON.parse(String(params[1]))).toHaveLength(20);
  });
});
