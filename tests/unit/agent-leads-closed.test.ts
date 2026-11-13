/**
 * Заявки платформы агентам закрыты (26.09).
 *
 * Аудит кабинета агента: GET /api/agent/leads отдавал имя, телефон и
 * комментарий ВСЕХ лидов платформы, а PATCH правил любой лид — любому
 * аккаунту с ролью agent. Роль agent выдаёт самостоятельная регистрация
 * (/api/auth/register), то есть ПД туристов получал любой, кто
 * зарегистрировался. Владения лидом у агента в схеме нет — доступ закрыт
 * целиком, администратор работает как раньше.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const { queryMock, roleRef } = vi.hoisted(() => ({ queryMock: vi.fn(), roleRef: { role: 'agent' } }));

vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/auth/middleware', () => ({
  requireAgent: async () => ({ userId: 'u-1', role: roleRef.role, email: 'a@example.com' }),
}));

import { GET } from '@/app/api/agent/leads/route';
import { PATCH } from '@/app/api/agent/leads/[id]/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{ total: '0' }], rowCount: 1 });
});

describe('заявки платформы — не для агента', () => {
  it('GET агенту — 403, база не спрашивается', async () => {
    roleRef.role = 'agent';
    const res = await GET(new Request('http://x/api/agent/leads') as unknown as NextRequest);
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('PATCH агенту — 403, лид не меняется', async () => {
    roleRef.role = 'agent';
    const req = new Request('http://x/api/agent/leads/1', { method: 'PATCH', body: JSON.stringify({ status: 'lost' }) });
    const res = await PATCH(req as unknown as NextRequest, { params: { id: '1' } });
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('администратор работает как раньше', async () => {
    roleRef.role = 'admin';
    const res = await GET(new Request('http://x/api/agent/leads') as unknown as NextRequest);
    expect(res.status).toBe(200);
  });
});

describe('правка статуса администратором и заявка, которую отменил клиент (1427)', () => {
  const patch = (status = 'contacted') => PATCH(
    new Request('http://x/api/agent/leads/l-1', { method: 'PATCH', body: JSON.stringify({ status }) }) as unknown as NextRequest,
    { params: { id: 'l-1' } },
  );

  it('живая заявка: запись условная — четвёртый параметр «отменена клиентом»', async () => {
    roleRef.role = 'admin';
    queryMock.mockResolvedValue({ rows: [{ id: 'l-1', status: 'contacted', notes: null, prev_status: 'contacted' }], rowCount: 1 });
    const res = await patch();
    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \$1 AND status <> \$4/);
    expect(params).toEqual(['l-1', 'contacted', null, 'cancelled']);
  });

  it('заявку отменил клиент — 409 своими словами, а не «не найден»; пропавший лид — по-прежнему 404', async () => {
    roleRef.role = 'admin';
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ status: 'cancelled' }], rowCount: 1 });
    const res = await patch('lost');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'Заявку отменил клиент — статус не меняется' });

    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await patch('lost')).status).toBe(404);
  });
});

describe('агентский раздел', () => {

  it('раздела «Заявки» нет в меню и на обзоре агента', () => {
    expect(read('app/hub/agent/layout.tsx')).not.toMatch(/\/hub\/agent\/leads/);
    expect(read('app/hub/agent/_AgentDashboardClient.tsx')).not.toMatch(/\/api\/agent\/leads|\/hub\/agent\/leads/);
  });
});
