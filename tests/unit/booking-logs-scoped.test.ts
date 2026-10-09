/**
 * Сторож: журнал статусов брони читают только её турист, агент, который её
 * завёл, оператор тура и администратор (lib/bookings/read-access.ts).
 *
 * До 09.10 `GET /api/bookings/[id]/logs` отдавал журнал любой брони любому
 * вошедшему — по порядковому номеру, с именем и почтой менявшего статус.
 * Найдено переписью кабинетов под CRM (#2325, шаг 0в).
 *
 * Поведением, на подменённой базе: чужому — 404 и журнал не читается;
 * своему — 200; база не ответила — 503, а не «не найдена»; почты менявшего
 * в SELECT нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  auth: { userId: 'u-1', role: 'tourist' as string, email: 't@x.ru' },
  own: vi.fn(),      // pool.query — владение
  logs: vi.fn(),     // query — журнал
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: vi.fn(async () => h.auth) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => h.own(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => h.logs(...a) }));

import { GET } from '@/app/api/bookings/[id]/logs/route';
import { canReadBooking } from '@/lib/bookings/read-access';

const req = {} as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.own.mockReset();
  h.logs.mockReset();
  h.logs.mockResolvedValue({ rows: [{ id: 'l1', from_status: 'new', to_status: 'confirmed', changer_name: 'Оп' }] });
});

describe('журнал брони — только своим', () => {
  it('турист чужой брони получает 404, журнал не читается', async () => {
    h.auth = { userId: 'u-1', role: 'tourist', email: 't@x.ru' };
    h.own.mockResolvedValue({ rows: [] });
    const res = await GET(req, ctx('42'));
    expect(res.status).toBe(404);
    expect(h.logs).not.toHaveBeenCalled();
    const [sql, params] = h.own.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/user_id = \$2 OR agent_user_id = \$2/);
    expect(params).toEqual(['42', 'u-1']);
  });

  it('турист своей брони — 200', async () => {
    h.auth = { userId: 'u-1', role: 'tourist', email: 't@x.ru' };
    h.own.mockResolvedValue({ rows: [{ 1: 1 }] });
    const res = await GET(req, ctx('42'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
  });

  it('оператор чужого тура — 404; оператор своего — 200', async () => {
    h.auth = { userId: 'op-1', role: 'operator', email: 'o@x.ru' };
    h.own.mockResolvedValueOnce({ rows: [] });
    expect((await GET(req, ctx('42'))).status).toBe(404);
    expect(h.logs).not.toHaveBeenCalled();
    h.own.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    expect((await GET(req, ctx('42'))).status).toBe(200);
    expect(String(h.own.mock.calls[1]?.[0])).toMatch(/JOIN partners p ON t\.operator_id = p\.id/);
  });

  it('база не ответила — 503, не «не найдена»', async () => {
    h.auth = { userId: 'u-1', role: 'tourist', email: 't@x.ru' };
    h.own.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    const res = await GET(req, ctx('42'));
    expect(res.status).toBe(503);
    expect(h.logs).not.toHaveBeenCalled();
  });

  it('администратор читает без запроса владения; номер не из цифр — 404 без базы', async () => {
    h.auth = { userId: 'a-1', role: 'admin', email: 'a@x.ru' };
    expect((await GET(req, ctx('42'))).status).toBe(200);
    expect(h.own).not.toHaveBeenCalled();
    expect(await canReadBooking('42 OR 1=1', { userId: 'u', role: 'tourist' })).toBe('denied');
    expect(h.own).not.toHaveBeenCalled();
  });

  it('почта менявшего статус в SELECT не выбирается', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/bookings/[id]/logs/route.ts'), 'utf8');
    expect(src).not.toMatch(/u\.email|changer_email|bl\.\*/);
    expect(src).toMatch(/canReadBooking/);
  });
});
