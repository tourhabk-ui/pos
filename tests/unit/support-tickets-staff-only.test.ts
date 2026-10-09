/**
 * Сторож: тикеты поддержки читает и ведёт только служба поддержки —
 * администратор (lib/support/staff.ts).
 *
 * До 09.10 роуты считали службой поддержки и роль `agent`. Но `agent` —
 * турагент, роль выдаёт самостоятельная регистрация: любой, назвавшийся
 * турагентом, читал все тикеты всех пользователей (имена, почту, текст
 * обращений), менял их статус и отвечал от имени поддержки (pd-guard §3).
 *
 * Поведением, на подменённом сервисе тикетов: турагент видит только свои
 * тикеты, чужой не открывает, статус не меняет и пишет как пользователь;
 * администратор — всё, как раньше.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  role: 'agent',
  svc: {
    listTickets: vi.fn(async () => [{ id: 'all' }]),
    listUserTickets: vi.fn(async () => [{ id: 'mine' }]),
    getTicketById: vi.fn(async () => ({ id: 't-other', messages: [] })),
    getTicketForUser: vi.fn(async () => null),
    addTicketMessage: vi.fn(async () => undefined),
    updateTicket: vi.fn(async () => ({ id: 't-other' })),
  },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: vi.fn(async () => ({ userId: 'u-agent', role: h.role, email: 'a@x.ru' })),
}));
vi.mock('@/lib/support/ticket.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/support/ticket.service')>()),
  ...h.svc,
}));
const svc = h.svc;

import { GET as listRoute } from '@/app/api/support/tickets/route';
import { GET as getRoute, PUT as putRoute } from '@/app/api/support/tickets/[id]/route';
import { GET as getMessages, POST as postMessage } from '@/app/api/support/tickets/[id]/messages/route';
import { isSupportStaff, SUPPORT_STAFF_ROLES } from '@/lib/support/staff';

const req = (url: string, body?: unknown) => ({
  nextUrl: new URL(url),
  json: async () => body,
}) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: 't-other' }) };

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockClear();
});

describe('турагент — не служба поддержки', () => {
  beforeEach(() => { h.role = 'agent'; });

  it('список — только свои тикеты', async () => {
    const res = await listRoute(req('http://x/api/support/tickets'));
    expect((await res.json()).data).toEqual([{ id: 'mine' }]);
    expect(svc.listTickets).not.toHaveBeenCalled();
    expect(svc.listUserTickets).toHaveBeenCalledWith('u-agent', expect.anything());
  });

  it('чужой тикет не открывается, переписка чужого — тоже', async () => {
    expect((await getRoute(req('http://x/api/support/tickets/t-other'), ctx)).status).toBe(404);
    expect((await getMessages(req('http://x/api/support/tickets/t-other/messages'), ctx)).status).toBe(404);
    expect(svc.getTicketById).not.toHaveBeenCalled();
    expect(svc.getTicketForUser).toHaveBeenCalledWith('t-other', 'u-agent');
  });

  it('статус не меняет и от имени поддержки не пишет', async () => {
    expect((await putRoute(req('http://x/api/support/tickets/t-other', { status: 'closed' }), ctx)).status).toBe(403);
    expect(svc.updateTicket).not.toHaveBeenCalled();
    expect((await postMessage(req('http://x/api/support/tickets/t-other/messages', { content: 'Здравствуйте' }), ctx)).status).toBe(404);
    expect(svc.addTicketMessage).not.toHaveBeenCalled();
  });
});

describe('администратор — служба поддержки, как раньше', () => {
  beforeEach(() => { h.role = 'admin'; });

  it('видит все тикеты, открывает любой и отвечает как поддержка', async () => {
    expect((await (await listRoute(req('http://x/api/support/tickets'))).json()).data).toEqual([{ id: 'all' }]);
    expect((await getRoute(req('http://x/api/support/tickets/t-other'), ctx)).status).toBe(200);
    const res = await postMessage(req('http://x/api/support/tickets/t-other/messages', { content: 'Ответ' }), ctx);
    expect((await res.json()).data.role).toBe('agent');
    expect(svc.addTicketMessage).toHaveBeenCalledWith('t-other', { role: 'agent', text: 'Ответ' });
  });
});

describe('одно правило на все роуты тикетов', () => {
  it('только администратор; самостоятельные роли — нет', () => {
    expect(isSupportStaff('admin')).toBe(true);
    for (const r of ['agent', 'operator', 'guide', 'stay', 'gear', 'transfer', 'tourist', undefined, null]) {
      expect(isSupportStaff(r as string | undefined), String(r)).toBe(false);
    }
  });

  it('в роутах поддержки нет своей проверки роли мимо lib/support/staff', () => {
    // Не только тикеты. Тем же списком requireRole(['admin', 'agent']) роль
    // `agent` пускали ещё четыре роута: /api/support/feedback (все отзывы с
    // customer_id и текстом), /api/support/knowledge-base (запись статей
    // справки, которую GET отдаёт без входа), /api/support/agents и
    // /api/support/sla.
    const dir = join(process.cwd(), 'app/api/support');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name === 'route.ts' ? [join(d, e.name)] : []));
    const files = walk(dir);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/auth\.role === '(agent|admin)'/);
      expect(src, f).not.toMatch(/requireRole\([^)]*'agent'/);
    }
  });

  it('список ролей поддержки — тот же, что у isSupportStaff', () => {
    expect([...SUPPORT_STAFF_ROLES]).toEqual(['admin']);
    for (const f of [
      'app/api/support/feedback/route.ts', 'app/api/support/knowledge-base/route.ts',
      'app/api/support/agents/route.ts', 'app/api/support/sla/route.ts',
    ]) {
      expect(readFileSync(join(process.cwd(), f), 'utf8'), f).toMatch(/requireRole\(request, \[\.\.\.SUPPORT_STAFF_ROLES\]\)/);
    }
  });
});
