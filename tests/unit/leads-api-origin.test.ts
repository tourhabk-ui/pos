/**
 * Роуты лидов отдают подпись «откуда» и не отдают канал согласия (08.11,
 * владелец: «нужно писать, откуда лиды — человек или ИИ и через какой
 * инструмент»).
 *
 * Судится вызовом GET /api/leads и GET /api/leads/[id]: строка базы с
 * записанным входом и каналом согласия — в ответе поле `origin` словами, а
 * `pd_consent_source` нет (экрану нужна только подпись). Подменены вход
 * администратора и база; правило подписи — настоящее.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/auth/middleware', () => {
  const admin = async () => ({ userId: 'admin-test', role: 'admin', email: 'a@test' });
  return { requireRole: vi.fn(admin), requireOperator: vi.fn(admin), requireAdmin: vi.fn(admin) };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/leads/lead-bookings', () => ({ bookingsForLead: vi.fn(async () => ({ kind: 'ok', rows: [] })) }));

import { GET as listLeads } from '@/app/api/leads/route';
import { GET as getLead } from '@/app/api/leads/[id]/route';

const ROW = {
  id: 'l-1', name: 'Тест', phone: '+70000000000', email: null, comment: null, route_id: null, route_title: null,
  source_url: 'mcp://vedar/booking', source_data: { source: 'mcp', entry: 'a2a', tool: 'create_booking_request' },
  status: 'new', notes: null, created_at: new Date('2026-11-08T05:00:00Z'), updated_at: new Date('2026-11-08T05:00:00Z'),
  pd_consent_source: 'mcp',
};

beforeEach(() => {
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 1 }] };
    if (/FROM leads/.test(sql)) return { rows: [{ ...ROW }] };
    return { rows: [] };
  });
});

describe('GET /api/leads', () => {
  it('у лида подпись «откуда», канала согласия в ответе нет; выбран он только ради подписи', async () => {
    const res = await listLeads(new NextRequest('https://vedarai.ru/api/leads?status=all&limit=50'));
    expect(res.status).toBe(200);
    const body = await res.json() as { leads: Array<Record<string, unknown>> };
    expect(body.leads[0]!.origin).toMatchObject({ actor: 'agent', label: 'ИИ-агент · A2A · заявка на тур' });
    expect(body.leads[0]).not.toHaveProperty('pd_consent_source');
    const select = query.mock.calls.map((c) => String(c[0])).find((s) => /SELECT id, name/.test(s));
    expect(select).toMatch(/pd_consent_source/);
  });

  it('старая заявка без входа: подпись по следу согласия и дате', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 1 }] };
      return { rows: [{ ...ROW, source_data: { source: 'mcp', tool: 'create_booking_request' }, pd_consent_source: 'kuzmich-tg' }] };
    });
    const body = await (await listLeads(new NextRequest('https://vedarai.ru/api/leads?status=all'))).json() as { leads: Array<{ origin: { label: string } }> };
    expect(body.leads[0]!.origin.label).toBe('Человек · Кузьмич в Telegram · заявка на тур');
  });
});

describe('GET /api/leads/[id]', () => {
  it('карточка лида — та же подпись, канала согласия нет', async () => {
    const res = await getLead(new NextRequest('https://vedarai.ru/api/leads/l-1'), { params: Promise.resolve({ id: 'l-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { lead: Record<string, unknown> };
    expect(body.lead.origin).toMatchObject({ actor: 'agent', label: 'ИИ-агент · A2A · заявка на тур' });
    expect(body.lead).not.toHaveProperty('pd_consent_source');
  });
});
