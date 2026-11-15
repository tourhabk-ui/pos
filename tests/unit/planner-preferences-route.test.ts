/**
 * /api/planner/preferences (разбор 14.11, экран-17): текст исключения базы
 * наружу не уходит, битый JSON — 400, потолок взрослых — тот же, что у
 * сборки плана (lib/planner/party-limits).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { remember, get } = vi.hoisted(() => ({ remember: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: vi.fn(async () => ({ userId: 'u-1' })) }));
vi.mock('@/lib/agents/memory/agent-memory', () => ({ agentMemory: { remember, get } }));

import { POST, GET } from '@/app/api/planner/preferences/route';
import { MAX_ADULTS } from '@/lib/planner/party-limits';

const post = (body: string) => POST(new NextRequest('http://localhost/api/planner/preferences', {
  method: 'POST', body, headers: { 'content-type': 'application/json' },
}));
const ok = (adults: number) => JSON.stringify({ interests: ['volcano'], fitnessLevel: 'moderate', budgetTier: 'comfort', adults });

beforeEach(() => { remember.mockReset(); get.mockReset(); });

describe('/api/planner/preferences', () => {
  it('отказ базы — 500 своими словами, без текста исключения; причина в логе', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    remember.mockImplementation(async () => { throw Object.assign(new Error('relation "agent_memory" does not exist'), { code: '42P01' }); });
    const res = await post(ok(2));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('agent_memory');
    expect(body).toContain('Предпочтения не сохранились');
    expect(log).toHaveBeenCalledWith('[planner-preferences] сохранение предпочтений не выполнен', expect.objectContaining({ code: '42P01' }));
    log.mockRestore();
  });

  it('чтение: тот же отказ — без текста исключения', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    get.mockImplementation(async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); });
    const res = await GET(new NextRequest('http://localhost/api/planner/preferences'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('10.0.0.5');
    log.mockRestore();
  });

  it('битый JSON — 400', async () => {
    expect((await post('{')).status).toBe(400);
    expect(remember).not.toHaveBeenCalled();
  });

  it(`взрослых до ${MAX_ADULTS}, как у сборки плана`, async () => {
    remember.mockResolvedValue(undefined);
    expect((await post(ok(MAX_ADULTS))).status).toBe(200);
    expect((await post(ok(MAX_ADULTS + 1))).status).toBe(400);
  });
});
