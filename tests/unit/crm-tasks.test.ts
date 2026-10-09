/**
 * Сторож задач партнёра (CRM 1в, #2325).
 *
 * Держит форму дверей: партнёр и автор — из гарда, а не из тела; задача о
 * чужом клиенте — 404, как о несуществующем; выполненная не правится. Срок —
 * по Камчатке, как вся лента: «в 10:00» значит 10:00 у клиента, а не в поясе
 * браузера. И SQL задач скоупится партнёром — каждый, без исключений.
 * Исполнение SQL — в интеграционном crm-contacts.pg.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import {
  defaultDueLocal, dueBucket, isoToKamchatkaLocal, kamchatkaLocalToIso,
} from '@/lib/crm/task-time';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const requirePartner = vi.fn();
const listTasks = vi.fn();
const createTask = vi.fn();
const updateTask = vi.fn();
const completeTask = vi.fn();
const deleteTask = vi.fn();
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/crm/tasks', () => ({
  listTasks: (...a: unknown[]) => listTasks(...a),
  createTask: (...a: unknown[]) => createTask(...a),
  updateTask: (...a: unknown[]) => updateTask(...a),
  completeTask: (...a: unknown[]) => completeTask(...a),
  deleteTask: (...a: unknown[]) => deleteTask(...a),
}));

const list = await import('@/app/api/hub/crm/tasks/route');
const one = await import('@/app/api/hub/crm/tasks/[id]/route');

const OK = { outcome: 'ok', partnerId: 'p-1', category: 'guide', userId: 'u-1' };
const UUID = '00000000-0000-4000-8000-000000000001';
const CONTACT = '00000000-0000-4000-8000-0000000000c1';
const TASK = { id: UUID, title: 'Перезвонить', details: null, due_at: '2030-01-01T00:00:00.000Z', done_at: null, contact: null, created_at: '2026-10-09T00:00:00.000Z' };

const req = (path: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://localhost${path}`, {
  method: init?.method ?? 'GET',
  body: init?.body === undefined ? undefined : JSON.stringify(init.body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requirePartner.mockReset().mockResolvedValue(OK);
  for (const f of [listTasks, createTask, updateTask, completeTask, deleteTask]) f.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET/POST /api/hub/crm/tasks', () => {
  it('гард не пустил — его ответ, база не тронута', async () => {
    requirePartner.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    expect((await list.GET(req('/api/hub/crm/tasks'))).status).toBe(403);
    expect((await list.POST(req('/api/hub/crm/tasks', { method: 'POST', body: { title: 'x', due_at: TASK.due_at } }))).status).toBe(403);
    expect(listTasks).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('список: партнёр из гарда; статус и клиент — проверены, чужой partner_id в адресе не действует', async () => {
    listTasks.mockResolvedValue([TASK]);
    const r = await list.GET(req(`/api/hub/crm/tasks?status=done&contact_id=${CONTACT}&partner_id=p-chuzhoi`));
    expect(r.status).toBe(200);
    expect(listTasks).toHaveBeenCalledWith('p-1', { status: 'done', contactId: CONTACT });
    expect((await list.GET(req('/api/hub/crm/tasks?status=all'))).status).toBe(400);
    expect((await list.GET(req('/api/hub/crm/tasks?contact_id=1;DROP'))).status).toBe(400);
    listTasks.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await list.GET(req('/api/hub/crm/tasks'))).status).toBe(503);
  });

  it('новая задача: автор из гарда; срок обязателен и с поясом; заголовок не пустой', async () => {
    createTask.mockResolvedValue({ outcome: 'created', task: TASK });
    const r = await list.POST(req('/api/hub/crm/tasks', {
      method: 'POST',
      body: { title: ' Перезвонить ', due_at: '2030-01-01T12:00:00+12:00', contact_id: CONTACT, partner_id: 'p-chuzhoi' },
    }));
    expect(r.status).toBe(201);
    expect(createTask.mock.calls[0][0]).toBe('p-1');
    expect(createTask.mock.calls[0][1]).toMatchObject({ title: 'Перезвонить', contactId: CONTACT, createdBy: 'u-1' });
    expect((createTask.mock.calls[0][1].dueAt as Date).toISOString()).toBe('2030-01-01T00:00:00.000Z');

    expect((await list.POST(req('/api/hub/crm/tasks', { method: 'POST', body: { title: 'x' } }))).status).toBe(400);
    expect((await list.POST(req('/api/hub/crm/tasks', { method: 'POST', body: { title: '  ', due_at: TASK.due_at } }))).status).toBe(400);
    expect((await list.POST(req('/api/hub/crm/tasks', { method: 'POST', body: { title: 'x', due_at: 'завтра' } }))).status).toBe(400);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('клиент чужой или удалён — 404; отказ базы — 503', async () => {
    createTask.mockResolvedValueOnce({ outcome: 'contact_not_found' });
    expect((await list.POST(req('/api/hub/crm/tasks', { method: 'POST', body: { title: 'x', due_at: TASK.due_at, contact_id: CONTACT } }))).status).toBe(404);
    createTask.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '23503' }));
    expect((await list.POST(req('/api/hub/crm/tasks', { method: 'POST', body: { title: 'x', due_at: TASK.due_at } }))).status).toBe(503);
  });
});

describe('PATCH/DELETE /api/hub/crm/tasks/[id]', () => {
  it('выполнить: автор отметки — из гарда; повтор или чужая — 404', async () => {
    completeTask.mockResolvedValueOnce({ outcome: 'done', task: { ...TASK, done_at: '2026-10-09T10:00:00.000Z' } });
    const r = await one.PATCH(req(`/api/hub/crm/tasks/${UUID}`, { method: 'PATCH', body: { action: 'done' } }), ctx(UUID));
    expect(r.status).toBe(200);
    expect(completeTask).toHaveBeenCalledWith('p-1', UUID, 'u-1');
    expect(updateTask).not.toHaveBeenCalled();
    completeTask.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await one.PATCH(req(`/api/hub/crm/tasks/${UUID}`, { method: 'PATCH', body: { action: 'done' } }), ctx(UUID))).status).toBe(404);
  });

  it('отметка и правка в одном теле — 400: неясно, что делать', async () => {
    const r = await one.PATCH(req(`/api/hub/crm/tasks/${UUID}`, { method: 'PATCH', body: { action: 'done', title: 'x' } }), ctx(UUID));
    expect(r.status).toBe(400);
    expect((await one.PATCH(req(`/api/hub/crm/tasks/${UUID}`, { method: 'PATCH', body: {} }), ctx(UUID))).status).toBe(400);
    expect(completeTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('перенос срока: партнёр из гарда; выполненная или чужая — 404', async () => {
    updateTask.mockResolvedValueOnce(TASK);
    const r = await one.PATCH(req(`/api/hub/crm/tasks/${UUID}`, { method: 'PATCH', body: { due_at: '2030-01-02T10:00:00+12:00' } }), ctx(UUID));
    expect(r.status).toBe(200);
    expect(updateTask.mock.calls[0][0]).toBe('p-1');
    expect((updateTask.mock.calls[0][2].dueAt as Date).toISOString()).toBe('2030-01-01T22:00:00.000Z');
    updateTask.mockResolvedValueOnce(null);
    expect((await one.PATCH(req(`/api/hub/crm/tasks/${UUID}`, { method: 'PATCH', body: { title: 'x' } }), ctx(UUID))).status).toBe(404);
  });

  it('не uuid — 404 без похода в базу; удаление чужой — 404', async () => {
    expect((await one.PATCH(req('/api/hub/crm/tasks/1', { method: 'PATCH', body: { action: 'done' } }), ctx('1; DROP'))).status).toBe(404);
    expect((await one.DELETE(req('/api/hub/crm/tasks/1', { method: 'DELETE' }), ctx('1; DROP'))).status).toBe(404);
    expect(completeTask).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
    deleteTask.mockResolvedValueOnce(false);
    expect((await one.DELETE(req(`/api/hub/crm/tasks/${UUID}`, { method: 'DELETE' }), ctx(UUID))).status).toBe(404);
    expect(deleteTask).toHaveBeenCalledWith('p-1', UUID);
    deleteTask.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await one.DELETE(req(`/api/hub/crm/tasks/${UUID}`, { method: 'DELETE' }), ctx(UUID))).status).toBe(503);
  });
});

describe('SQL задач скоупится партнёром', () => {
  it('каждый запрос к crm_tasks — с partner_id = $1', () => {
    const src = read('lib/crm/tasks.ts');
    const sqls = [...src.matchAll(/`([^`]*\bcrm_tasks\b[^`]*)`/g)].map((m) => m[1]);
    // TASK_SELECT — общий хвост; условие стоит у каждого, кто его зовёт.
    const statements = sqls.filter((q) => /\b(WHERE|INSERT)\b/.test(q));
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const q of statements) expect(q, q.slice(0, 80)).toMatch(/partner_id\s*=\s*\$1|INSERT INTO crm_tasks \(partner_id/);
    expect(src).toMatch(/WHERE t\.partner_id = \$1/);
  });

  it('задача о клиенте заводится только для своего клиента', () => {
    const src = read('lib/crm/tasks.ts');
    expect(src).toMatch(/SELECT id, display_name FROM crm_contacts WHERE id = \$2::uuid AND partner_id = \$1/);
    expect(src).toMatch(/WHERE \$2::uuid IS NULL OR EXISTS \(SELECT 1 FROM owner\)/);
  });
});

describe('срок по Камчатке', () => {
  it('поле ввода читается как камчатское время, UTC+12', () => {
    expect(kamchatkaLocalToIso('2026-10-10T10:00')).toBe('2026-10-09T22:00:00.000Z');
    expect(isoToKamchatkaLocal('2026-10-09T22:00:00.000Z')).toBe('2026-10-10T10:00');
  });

  it('не дата — null, а не «сейчас»', () => {
    for (const bad of ['', 'завтра', '2026-02-30T10:00', '2026-10-10T24:00', '2026-13-01T10:00', '2026-10-10 10:00']) {
      expect(kamchatkaLocalToIso(bad), bad).toBeNull();
    }
  });

  it('по умолчанию — завтра в 10:00 по Камчатке, даже когда в UTC ещё «вчера»', () => {
    // 23:30 9 октября по Камчатке = 11:30 UTC того же дня.
    expect(defaultDueLocal(new Date('2026-10-09T11:30:00Z'))).toBe('2026-10-10T10:00');
    // 00:30 10 октября по Камчатке = 12:30 UTC 9 октября.
    expect(defaultDueLocal(new Date('2026-10-09T12:30:00Z'))).toBe('2026-10-11T10:00');
  });

  it('просрочено — по моменту; сегодня/завтра — по камчатскому календарю', () => {
    const now = new Date('2026-10-09T11:30:00Z'); // 23:30 по Камчатке
    expect(dueBucket('2026-10-09T11:00:00Z', now)).toBe('overdue');
    expect(dueBucket('2026-10-09T11:45:00Z', now)).toBe('today');
    // 00:30 по Камчатке — уже завтра, хотя в UTC тот же день.
    expect(dueBucket('2026-10-09T12:30:00Z', now)).toBe('tomorrow');
    expect(dueBucket('2026-10-11T12:30:00Z', now)).toBe('later');
  });
});
