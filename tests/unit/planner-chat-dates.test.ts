/**
 * Быстрая фраза планировщика: «7 дней» — семь дней, даты модели — только ISO,
 * отказ модели — в лог (разбор планера 14.11, экран-9).
 *
 * Судится ответ настоящего обработчика /api/planner/chat (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let modelReply: string | Error = '';
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(async () => { if (modelReply instanceof Error) throw modelReply; return modelReply; }),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { POST } from '@/app/api/planner/chat/route';

let ip = 0;
async function ask(message: string) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/planner/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.88.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ message }),
  }));
  return await res.json() as { success: boolean; arrival: string | null; departure: string | null; auto_recommend: boolean };
}
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T03:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('длительность — дни поездки, считая день прилёта', () => {
  it('модель не ответила: «вулканы, 7 дней» — ровно 7 дней, отказ в логе', async () => {
    modelReply = new Error('model down');
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    let r: Awaited<ReturnType<typeof ask>>;
    try { r = await ask('вулканы, 7 дней'); } finally { console.error = orig; }
    expect(r.arrival && r.departure && span(r.arrival, r.departure)).toBe(7);
    expect(errors.some((a) => String(a[0]).includes('[planner/chat]') && String(a[1]).includes('model down'))).toBe(true);
  });

  it('модель назвала длительность без дат — тоже ровно N дней', async () => {
    modelReply = JSON.stringify({ places: ['volcano'], activities: [], arrival: '2027-07-10', departure: null, duration_days: 7 });
    const r = await ask('вулканы на неделю с 10 июля');
    expect(r.arrival).toBe('2027-07-10');
    expect(r.departure).toBe('2027-07-16');
  });

  it('даты модели не в ISO не уходят дальше как есть', async () => {
    modelReply = JSON.stringify({ places: ['volcano'], activities: [], arrival: '10.07.2027', departure: '16.07.2027', duration_days: null });
    const r = await ask('вулканы 10.07.2027–16.07.2027');
    for (const d of [r.arrival, r.departure]) {
      if (d !== null) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
