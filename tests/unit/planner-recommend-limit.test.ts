// @vitest-environment node
/**
 * Сторож: у публичной сборки плана есть предел частоты, а отказ не отдаёт
 * текст исключения (#3199, (а)-1).
 *
 * /api/planner/recommend открыт без входа, а движок может звать флагманскую
 * модель. Общий лимит Edge работает только при Upstash, которого нет, — без
 * своего предела любой цикл со стороны платил бы моделью без счёта. Ключ
 * предела — доверенный адрес: x-real-ip ставит прокси, X-Forwarded-For
 * подделывается снаружи и лимит обходить не должен.
 *
 * Судится вызовом POST с подменённым движком.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const recommendTrip = vi.fn();
vi.mock('@/lib/planner/engine', () => ({ recommendTrip: (...a: unknown[]) => recommendTrip(...a) }));
vi.mock('@/lib/auth', () => ({ verifyAuth: vi.fn(async () => ({ userId: null })) }));
vi.mock('@/lib/agents/memory/agent-memory', () => ({
  agentMemory: { get: vi.fn(async () => null), remember: vi.fn(async () => undefined) },
}));

import { POST, RECOMMEND_LIMIT_PER_MIN } from '@/app/api/planner/recommend/route';

const BODY = { interests: ['volcano'], arrivalDate: '2030-08-03', departureDate: '2030-08-06' };

const post = (headers: Record<string, string>) => POST(new NextRequest('http://localhost/api/planner/recommend', {
  method: 'POST', body: JSON.stringify(BODY), headers: { 'content-type': 'application/json', ...headers },
}));

beforeEach(() => {
  recommendTrip.mockReset();
  recommendTrip.mockResolvedValue({ zones: [], days: [], warnings: [], itinerary: '' });
});

describe('/api/planner/recommend — предел частоты', () => {
  it('предел строже чата планера (20 в минуту)', () => {
    expect(RECOMMEND_LIMIT_PER_MIN).toBeGreaterThan(0);
    expect(RECOMMEND_LIMIT_PER_MIN).toBeLessThan(20);
  });

  it('сверх предела с одного адреса — 429, и движок не зовётся', async () => {
    for (let i = 0; i < RECOMMEND_LIMIT_PER_MIN; i += 1) {
      expect((await post({ 'x-real-ip': '10.1.1.1' })).status).toBe(200);
    }
    expect(recommendTrip).toHaveBeenCalledTimes(RECOMMEND_LIMIT_PER_MIN);
    const over = await post({ 'x-real-ip': '10.1.1.1' });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toMatch(/Слишком много запросов/);
    expect(recommendTrip).toHaveBeenCalledTimes(RECOMMEND_LIMIT_PER_MIN);
    // Другой человек — свой счёт.
    expect((await post({ 'x-real-ip': '10.1.1.2' })).status).toBe(200);
  });

  it('смена X-Forwarded-For при том же x-real-ip предел не обходит', async () => {
    for (let i = 0; i < RECOMMEND_LIMIT_PER_MIN; i += 1) {
      await post({ 'x-real-ip': '10.2.2.2', 'x-forwarded-for': `203.0.113.${i}` });
    }
    const over = await post({ 'x-real-ip': '10.2.2.2', 'x-forwarded-for': '198.51.100.7' });
    expect(over.status).toBe(429);
  });
});

describe('/api/planner/recommend — отказ движка', () => {
  it('500 без текста исключения в теле, отказ назван в логе', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    recommendTrip.mockRejectedValueOnce(new Error('relation "operator_tours" does not exist'));
    const res = await post({ 'x-real-ip': '10.3.3.3' });
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('operator_tours');
    expect(body).toContain('План не собрался');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[planner-recommend] сборка плана'))).toBe(true);
    spy.mockRestore();
  });
});
