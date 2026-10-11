/**
 * CRM фаза 2 (#2313, оператор пилотом): доска лидов у оператора и бронь из лида.
 *
 * Перепись 09.10, пробел 2: «Лид не доводится до сделки. У leads нет ссылки на
 * бронь, converted ставят руками; канбан есть только у админа». Теперь:
 *   - у оператора есть доска, и лиды конвейера на ней не пропадают;
 *   - кнопка «Завести бронь» на карточке лида заводит бронь с lead_id и
 *     ставит лиду «Сделку» одним запросом (миграция 1214);
 *   - карточка лида показывает его брони, отказ чтения — «не прочитались».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
const authMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: (...a: unknown[]) => authMock(...a),
  requireAdmin: vi.fn(),
  requireRole: vi.fn(),
}));
vi.mock('@/lib/notifications/operator-booking', () => ({ notifyNewBooking: vi.fn(async () => undefined) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn(async () => undefined) }));
const eventMock = vi.fn(async () => undefined);
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: (...a: unknown[]) => eventMock(...(a as [])),
  statusChangeTitle: (_k: string, from: string, to: string) => `${from} → ${to}`,
}));

import { LEAD_STATUSES, MANUAL_LEAD_STATUSES } from '@/lib/types/statuses';
import { OPERATOR_COLUMNS, ADMIN_COLUMNS } from '@/app/hub/admin/leads/_LeadsKanban';
import { POST } from '@/app/api/hub/operator/bookings/route';
import { bookingsForLead } from '@/lib/leads/lead-bookings';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const OPERATOR = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
  authMock.mockReset();
  eventMock.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('доска оператора: ни один лид не пропадает', () => {
  it('каждый статус лида — ровно в одной колонке', () => {
    const all = OPERATOR_COLUMNS.flatMap((c) => c.members);
    expect([...all].sort()).toEqual([...LEAD_STATUSES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('колонки ставят только ручные статусы; у админа доска прежняя', () => {
    expect(OPERATOR_COLUMNS.map((c) => c.key)).toEqual(MANUAL_LEAD_STATUSES);
    expect(ADMIN_COLUMNS.every((c) => c.members.length === 1 && c.members[0] === c.key)).toBe(true);
  });

  it('лид в обработке конвейером не переносится; точный статус виден на карточке', () => {
    const src = read('app/hub/admin/leads/_LeadsKanban.tsx');
    expect(src).toMatch(/disabled: lead\.status === 'ai_processing'/);
    expect(src).toMatch(/lead\.status !== columnKey \? STATUS_META\[lead\.status\]/);
  });

  it('страница лидов оператора: «Доска» с колонками оператора и ссылкой на лида', () => {
    const src = read('app/hub/operator/leads/_LeadsClient.tsx');
    expect(src).toMatch(/columns=\{OPERATOR_COLUMNS\}/);
    expect(src).toMatch(/cardHref=\{\(l\) => `\/hub\/operator\/leads\/\$\{l\.id\}`\}/);
    expect(src).toMatch(/Доска/);
  });
});

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://x/api/hub/operator/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Ответы базы для ручной брони: оператор, тур, лид (если виден), вставка. */
function routeDb(leadVisible: boolean, leadStatus = 'ai_qualified') {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM partners p/.test(sql)) return { rows: [{ id: OPERATOR, name: 'Оп', max_chat_id: null, telegram_chat_id: null }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [{ id: '7', title: 'Тур', base_price: 10000, price_unit: null, multi_day_count: null, duration_hours: null }] };
    if (/FROM leads WHERE id = \$1::uuid/.test(sql)) return { rows: leadVisible ? [{ id: LEAD_ID, status: leadStatus }] : [] };
    if (/INSERT INTO operator_bookings/.test(sql)) return { rows: [{ id: '501', booking_date: '2026-11-20', participants: 2, final_price: 20000, booking_status: 'new' }] };
    return { rows: [] };
  });
  // Скоуп лида (leadOwnershipCond) спрашивает партнёра через pool.
  poolQueryMock.mockImplementation(async (sql: string) => {
    if (/FROM partners WHERE user_id/.test(sql)) return { rows: [{ id: OPERATOR }] };
    return { rows: [] };
  });
}

const BASE = { operator_tour_id: 7, booking_date: '2026-11-20', participants: 2, tourist_name: 'Анна' };

describe('POST ручной брони: бронь из лида', () => {
  beforeEach(() => authMock.mockResolvedValue({ userId: 'u-1', role: 'operator' }));

  it('свой или ничейный лид: бронь с lead_id и «Сделка» лиду — одним запросом, событие в ленте', async () => {
    routeDb(true);
    const res = await POST(postReq({ ...BASE, lead_id: LEAD_ID }));
    expect(res.status).toBe(201);
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO operator_bookings/.test(String(c[0])));
    const sql = String(insert?.[0]);
    expect(sql).toMatch(/lead_id\)/);
    expect(sql).toMatch(/UPDATE leads[\s\S]*SET status = 'converted', operator_id = COALESCE\(operator_id, \$17::uuid\)/);
    expect(insert?.[1]).toEqual(expect.arrayContaining([LEAD_ID, OPERATOR]));
    expect(eventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'status_change', sourceKind: 'lead', sourceId: LEAD_ID,
      payload: expect.objectContaining({ from: 'ai_qualified', to: 'converted', booking_id: '501' }),
    }));
  });

  it('чужой лид — 404, брони нет', async () => {
    routeDb(false);
    const res = await POST(postReq({ ...BASE, lead_id: LEAD_ID }));
    expect(res.status).toBe(404);
    expect(queryMock.mock.calls.some((c) => /INSERT INTO operator_bookings/.test(String(c[0])))).toBe(false);
  });

  it('без лида запрос не упоминает lead_id — ручная бронь не зависит от миграции 1214', async () => {
    routeDb(true);
    const res = await POST(postReq(BASE));
    expect(res.status).toBe(201);
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO operator_bookings/.test(String(c[0])));
    expect(String(insert?.[0])).not.toMatch(/lead_id|UPDATE leads/);
    expect(eventMock).not.toHaveBeenCalled();
  });

  it('лид уже «Сделка» — второго события о смене статуса нет', async () => {
    routeDb(true, 'converted');
    await POST(postReq({ ...BASE, lead_id: LEAD_ID }));
    expect(eventMock).not.toHaveBeenCalled();
  });
});

describe('брони лида на карточке', () => {
  it('отказ базы — «не прочитано» и лог, а не пустой список', async () => {
    poolQueryMock.mockRejectedValue(Object.assign(new Error('column b.lead_id does not exist'), { code: '42703' }));
    expect(await bookingsForLead(LEAD_ID, OPERATOR)).toEqual({ kind: 'failed' });
    expect(console.error).toHaveBeenCalled();
  });

  it('оператору — только брони его туров', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await bookingsForLead(LEAD_ID, OPERATOR);
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toMatch(/t\.operator_id = \$2::uuid/);
    expect(params).toEqual([LEAD_ID, OPERATOR]);
  });

  it('GET лида отдаёт брони; null — не прочитались; экран это различает', () => {
    const route = read('app/api/leads/[id]/route.ts');
    expect(route).toMatch(/bookings: bookings\.kind === 'ok' \? bookings\.rows : null/);
    const ui = read('app/hub/operator/leads/[id]/_LeadDetailClient.tsx');
    expect(ui).toMatch(/href=\{`\/hub\/operator\/bookings\?lead=\$\{leadId\}`\}/);
    expect(ui).toMatch(/Брони по лиду не прочитались/);
  });

  it('форма брони берёт лид из ?lead= и шлёт lead_id', () => {
    const ui = read('app/hub/operator/bookings/_BookingsManagementClient.tsx');
    expect(ui).toMatch(/get\('lead'\)/);
    expect(ui).toMatch(/body\.lead_id\s*=\s*fromLead\.id/);
    expect(ui).toMatch(/лид станет «Сделкой»/);
  });

  it('миграция 1214: ссылка гаснет при удалении лида, бронь остаётся', () => {
    const sql = read('migrations/1214_booking_from_lead.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads\(id\) ON DELETE SET NULL/);
  });
});

