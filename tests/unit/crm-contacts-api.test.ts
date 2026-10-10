/**
 * Сторож роутов CRM и задела (CRM #2325).
 *
 * Роуты `/api/hub/*` Edge пускает по одному JWT, без роли (middleware.ts), —
 * значит партнёрство и скоуп роут проверяет сам. Здесь держится: каждый
 * обработчик начинается с requirePartner, каждый SQL по контактам несёт
 * `partner_id`, ручной контакт не записывает согласия, которого не собирали,
 * задел отвечает числами и не путает «не смог сосчитать» с нулём.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const ROOT = process.cwd();

const requirePartner = vi.fn();
const listContacts = vi.fn();
const createManualContact = vi.fn();
const getContactCard = vi.fn();
const updateContact = vi.fn();
const poolQuery = vi.fn();
const linkContactFromSource = vi.fn();

vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/crm/contact-queries', () => ({
  listContacts: (...a: unknown[]) => listContacts(...a),
  createManualContact: (...a: unknown[]) => createManualContact(...a),
  getContactCard: (...a: unknown[]) => getContactCard(...a),
  updateContact: (...a: unknown[]) => updateContact(...a),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/crm/contacts', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/contacts')>()),
  linkContactFromSource: (...a: unknown[]) => linkContactFromSource(...a),
}));

const list = await import('@/app/api/hub/crm/contacts/route');
const one = await import('@/app/api/hub/crm/contacts/[id]/route');
const sync = await import('@/app/api/cron/crm-contacts-sync/route');
const { SOURCE_KINDS } = await import('@/lib/crm/contacts');

// Гид: у оператора список идёт своей веткой с суммами (1а-2b) — её держит
// operator-clients-crm.test.ts, а здесь — общая дверь любой роли.
const OK = { outcome: 'ok', partnerId: 'p-1', category: 'guide', userId: 'u-1' };
const UUID = '00000000-0000-4000-8000-000000000001';

const req = (url: string, init?: { method?: string; body?: unknown; secret?: string }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? 'GET',
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    headers: init?.secret ? { authorization: `Bearer ${init.secret}` } : undefined,
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const f of [requirePartner, listContacts, createManualContact, getContactCard, updateContact, poolQuery, linkContactFromSource]) f.mockReset();
  requirePartner.mockResolvedValue(OK);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('форма роутов', () => {
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? routeFiles(p) : n === 'route.ts' ? [p] : [];
    });
  }

  it('каждый обработчик /api/hub/crm начинается с requirePartner', () => {
    const files = routeFiles(join(ROOT, 'app', 'api', 'hub', 'crm'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\([^)]*\)\s*\{\s*\n\s*const ctx = await requirePartner\(/g)];
      const exported = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)];
      expect(handlers.length, f).toBe(exported.length);
    }
  });

  it('каждый SQL по контактам скоупится partner_id', () => {
    for (const [file, min] of [['contact-queries.ts', 5], ['operator-clients-sql.ts', 1]] as const) {
      const src = readFileSync(join(ROOT, 'lib', 'crm', file), 'utf8');
      const sqls = [...src.matchAll(/`([^`]*\bcrm_contacts\b[^`]*)`/g)].map((m) => m[1]);
      expect(sqls.length, file).toBeGreaterThanOrEqual(min);
      for (const sql of sqls) expect(sql, `${file}: ${sql.slice(0, 80)}`).toMatch(/partner_id\s*=\s*\$\d|\(partner_id,/);
    }
  });

  it('ручной контакт не записывает согласия, которого не собирали', () => {
    const src = readFileSync(join(ROOT, 'lib', 'crm', 'contact-queries.ts'), 'utf8');
    const ins = /INSERT INTO crm_contacts([\s\S]*?)RETURNING/.exec(src)?.[1] ?? '';
    expect(ins).toMatch(/'manual'/);
    expect(ins).not.toMatch(/pd_consent/);
  });
});

describe('список и ручной контакт', () => {
  it('партнёр не прошёл гард — ответ гарда, база не тронута', async () => {
    requirePartner.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await list.GET(req('/api/hub/crm/contacts'))).status).toBe(403);
    expect(listContacts).not.toHaveBeenCalled();
  });

  it('список скоупится партнёром из гарда, а не из запроса', async () => {
    listContacts.mockResolvedValueOnce({ items: [], total: 0 });
    const r = await list.GET(req('/api/hub/crm/contacts?q=Анна&page=2&partner_id=p-chuzhoi'));
    expect(r.status).toBe(200);
    expect(listContacts.mock.calls[0][0]).toBe('p-1');
    expect(listContacts.mock.calls[0][1]).toMatchObject({ q: 'Анна', offset: 30 });
  });

  it('база не ответила — 503, а не пустой список', async () => {
    listContacts.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    const r = await list.GET(req('/api/hub/crm/contacts'));
    expect(r.status).toBe(503);
  });

  it('дубль — 409 с id существующего; плохой номер — 400; без имени — 400', async () => {
    createManualContact.mockResolvedValueOnce({ outcome: 'exists', id: UUID });
    const dup = await list.POST(req('/api/hub/crm/contacts', { method: 'POST', body: { display_name: 'Иван', phone: '+79140009988' } }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).data).toEqual({ id: UUID });

    createManualContact.mockResolvedValueOnce({ outcome: 'bad_phone' });
    expect((await list.POST(req('/api/hub/crm/contacts', { method: 'POST', body: { display_name: 'Иван', phone: '12' } }))).status).toBe(400);

    expect((await list.POST(req('/api/hub/crm/contacts', { method: 'POST', body: { display_name: '  ' } }))).status).toBe(400);
    expect(createManualContact).toHaveBeenCalledTimes(2);
  });
});

describe('карточка', () => {
  it('не uuid — 404 без похода в базу; чужая — 404 как несуществующая', async () => {
    expect((await one.GET(req('/api/hub/crm/contacts/1'), ctx('1; DROP'))).status).toBe(404);
    expect(getContactCard).not.toHaveBeenCalled();
    getContactCard.mockResolvedValueOnce(null);
    expect((await one.GET(req(`/api/hub/crm/contacts/${UUID}`), ctx(UUID))).status).toBe(404);
    expect(getContactCard.mock.calls[0]).toEqual(['p-1', UUID]);
  });

  it('пустая правка — 400 «Нечего сохранять»', async () => {
    const r = await one.PATCH(req(`/api/hub/crm/contacts/${UUID}`, { method: 'PATCH', body: {} }), ctx(UUID));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Нечего сохранять');
    expect(updateContact).not.toHaveBeenCalled();
  });
});

describe('задел crm-contacts-sync', () => {
  beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; });

  it('без секрета — 401', async () => {
    expect((await sync.GET(req('/api/cron/crm-contacts-sync'))).status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('неизвестный вид — 400', async () => {
    expect((await sync.GET(req('/api/cron/crm-contacts-sync?kind=tour_seat_request', { secret: 'test-secret' }))).status).toBe(400);
  });

  it('сухой прогон: числа по видам, ничего не пишет', async () => {
    poolQuery.mockResolvedValue({ rows: [{ n: 3 }] });
    const r = await sync.GET(req('/api/cron/crm-contacts-sync', { secret: 'test-secret' }));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ success: true, apply: false, total: 3 * SOURCE_KINDS.length });
    expect(linkContactFromSource).not.toHaveBeenCalled();
    for (const [sql] of poolQuery.mock.calls as [string][]) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('«не смог сосчитать» — не ноль: вид назван, ответ 503', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM leads')) throw Object.assign(new Error('x'), { code: '42P01' });
      return { rows: [{ n: 1 }] };
    });
    const r = await sync.GET(req('/api/cron/crm-contacts-sync', { secret: 'test-secret' }));
    const body = await r.json();
    expect(r.status).toBe(503);
    expect(body.unlinked.lead).toBeNull();
    expect(body.failed).toEqual([{ kind: 'lead', sqlstate: '42P01' }]);
    expect(body.total).toBe(SOURCE_KINDS.length - 1);
  });

  it('запись: идёт курсором по порциям и считает исходы; в ответе только числа', async () => {
    // Полная порция (200) — значит, может быть следующая; короткая — конец.
    const pages = [Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1) })), [{ id: '201' }]];
    poolQuery.mockImplementation(async () => ({ rows: pages.shift() ?? [] }));
    linkContactFromSource.mockResolvedValue({ outcome: 'linked', partnerId: 'p', contactId: 'c', created: false });
    linkContactFromSource
      .mockResolvedValueOnce({ outcome: 'linked', partnerId: 'p', contactId: 'c', created: true })
      .mockResolvedValueOnce({ outcome: 'no_contact' });
    const r = await sync.GET(req('/api/cron/crm-contacts-sync?apply=1&kind=operator_booking', { secret: 'test-secret' }));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ success: true, apply: true, complete: true });
    expect(body.by_kind.operator_booking).toEqual({ scanned: 201, created: 1, attached: 199, no_contact: 1, no_source: 0, failed: 0 });
    // Вторая порция спрошена после последнего id первой, а не с начала:
    // строка без примет (no_contact) иначе возвращалась бы в каждую порцию.
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(poolQuery.mock.calls[1][1]).toEqual(['200', 200]);
    expect(JSON.stringify(body)).not.toMatch(/\+7|@/);
  });

  it('отказ привязки — success:false и 503, а не тихий ноль', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: '1' }] });
    linkContactFromSource.mockResolvedValueOnce({ outcome: 'failed', reason: 'link 40P01' });
    const r = await sync.GET(req('/api/cron/crm-contacts-sync?apply=1&kind=operator_booking', { secret: 'test-secret' }));
    expect(r.status).toBe(503);
    expect((await r.json()).by_kind.operator_booking.failed).toBe(1);
  });
});
