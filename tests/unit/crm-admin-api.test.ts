/**
 * Сторож: клиенты всех партнёров у администратора — просмотр
 * (CRM #2325, решение владельца 09.10) и одно действие — стереть карточку по
 * обращению человека (152-ФЗ, #2327).
 *
 * `lib/crm/admin-queries.ts` читает контакты БЕЗ скоупа партнёра — по
 * замыслу, это экран администратора. Поэтому держится и обратное: звать
 * модуль можно только из роутов /api/admin/crm под requireAdmin, а у роутов
 * списка и карточки нет обработчиков записи — метки и заметки клиента ведёт
 * партнёр. Стирание по обращению — отдельный роут (…/[id]/erase): только
 * под requireAdmin, с основанием без ПД и записью в журнал в той же
 * транзакции; без записи в журнале стирания нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const ROOT = process.cwd();

const requireAdmin = vi.fn();
const listAllContacts = vi.fn();
const getContactCardForAdmin = vi.fn();
const eraseCrmContactOnRequest = vi.fn();
/** Что роут стирания послал базе — по порядку (BEGIN, журнал, COMMIT/ROLLBACK). */
const sent: Array<{ text: string; params?: unknown[] }> = [];
let failOn: RegExp | null = null;
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));
vi.mock('@/lib/crm/admin-queries', () => ({
  listAllContacts: (...a: unknown[]) => listAllContacts(...a),
  getContactCardForAdmin: (...a: unknown[]) => getContactCardForAdmin(...a),
}));
vi.mock('@/lib/account/erase', () => ({
  eraseCrmContactOnRequest: (...a: unknown[]) => eraseCrmContactOnRequest(...a),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    connect: async () => ({
      query: async (text: string, params?: unknown[]) => {
        sent.push({ text, params });
        if (failOn?.test(text)) throw Object.assign(new Error('x'), { code: '23503' });
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    }),
  },
}));

const list = await import('@/app/api/admin/crm/contacts/route');
const one = await import('@/app/api/admin/crm/contacts/[id]/route');
const erase = await import('@/app/api/admin/crm/contacts/[id]/erase/route');

const UUID = '00000000-0000-4000-8000-000000000001';
const req = (url: string) => new NextRequest(`http://localhost${url}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

beforeEach(() => {
  for (const f of [requireAdmin, listAllContacts, getContactCardForAdmin, eraseCrmContactOnRequest]) f.mockReset();
  sent.length = 0;
  failOn = null;
  requireAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('форма роутов', () => {
  const routes = ['app/api/admin/crm/contacts/route.ts', 'app/api/admin/crm/contacts/[id]/route.ts'];

  it('только GET, и он начинается с requireAdmin', () => {
    for (const f of routes) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
      expect(exported, f).toEqual(['GET']);
      expect(src, f).toMatch(/export async function GET\([^)]*\)\s*\{\s*\n\s*const admin = await requireAdmin\(req\);/);
    }
  });

  it('контакты без скоупа партнёра читаются только из админских роутов', () => {
    const importers = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'components'))]
      .filter((f) => /from '@\/lib\/crm\/admin-queries'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    // Типы экрану нужны (`import type`), данные — только роутам.
    const valueImporters = importers.filter((f) => !/import type \{[^}]*\} from '@\/lib\/crm\/admin-queries'/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(valueImporters.sort()).toEqual(routes.slice().sort());
  });
});

describe('список', () => {
  it('не администратор — ответ гарда, база не тронута', async () => {
    requireAdmin.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await list.GET(req('/api/admin/crm/contacts'))).status).toBe(403);
    expect(listAllContacts).not.toHaveBeenCalled();
  });

  it('фильтры доходят до запроса; незнакомая роль — 400', async () => {
    listAllContacts.mockResolvedValueOnce({ items: [], total: 0, facets: { categories: [], partners: [] } });
    const r = await list.GET(req(`/api/admin/crm/contacts?q=Анна&category=stay&partner=${UUID}&page=2`));
    expect(r.status).toBe(200);
    expect(listAllContacts.mock.calls[0][0]).toMatchObject({ q: 'Анна', category: 'stay', partnerId: UUID, offset: 30 });
    expect((await list.GET(req('/api/admin/crm/contacts?category=superuser'))).status).toBe(400);
    expect((await list.GET(req('/api/admin/crm/contacts?partner=1; DROP'))).status).toBe(400);
  });

  it('база не ответила — 503, а не пустой список', async () => {
    listAllContacts.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await list.GET(req('/api/admin/crm/contacts'))).status).toBe(503);
  });
});

describe('карточка', () => {
  it('не uuid — 404 без похода в базу; нет такого — 404; есть — с партнёром', async () => {
    expect((await one.GET(req('/api/admin/crm/contacts/x'), ctx('x'))).status).toBe(404);
    expect(getContactCardForAdmin).not.toHaveBeenCalled();

    getContactCardForAdmin.mockResolvedValueOnce(null);
    expect((await one.GET(req(`/api/admin/crm/contacts/${UUID}`), ctx(UUID))).status).toBe(404);

    getContactCardForAdmin.mockResolvedValueOnce({ id: UUID, partner: { id: 'p', name: 'Гостиница', category: 'stay' } });
    const r = await one.GET(req(`/api/admin/crm/contacts/${UUID}`), ctx(UUID));
    expect(r.status).toBe(200);
    expect((await r.json()).data.partner).toEqual({ id: 'p', name: 'Гостиница', category: 'stay' });
  });
});

describe('стирание карточки по обращению (152-ФЗ, #2327)', () => {
  const post = (id: string, body: unknown) => erase.POST(
    new NextRequest(`http://localhost/api/admin/crm/contacts/${id}/erase`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    ctx(id),
  );
  // Основание — структура: дата обращения и, если есть, номер. Свободного
  // текста нет вовсе (ревью круга 10, #2327): отсев телефона и почты
  // пропускал имя, а основание лежит в журнале навсегда.
  const TODAY = new Date().toISOString().slice(0, 10);
  const BASIS = { received: TODAY, ticket: '17' };

  it('не администратор — ответ гарда, база не тронута', async () => {
    requireAdmin.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await post(UUID, BASIS)).status).toBe(403);
    expect(eraseCrmContactOnRequest).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('основание свободным текстом, без даты, с датой из будущего или не датой, с номером не из цифр — 422, ничего не стёрто', async () => {
    const tomorrowPlus = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const bad: unknown[] = [
      { reason: 'обращение Андрея Петрова от 22.10' },
      { received: TODAY, reason: 'обращение Андрея Петрова' },
      {},
      { ticket: '17' },
      { received: '22.10.2026' },
      { received: '2026-02-30' },
      { received: tomorrowPlus },
      { received: TODAY, ticket: 'Андрей' },
      { received: TODAY, ticket: '+79991234567' },
      { received: TODAY, ticket: '1234567890123' },
    ];
    for (const body of bad) {
      const r = await post(UUID, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    const free = await post(UUID, { received: TODAY, reason: 'обращение Андрея Петрова' });
    expect((await free.json()).error).toBe('Основание — только дата и номер обращения, без свободного текста');
    expect(eraseCrmContactOnRequest).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    // Дата без номера — основание: номера у письма может и не быть.
    eraseCrmContactOnRequest.mockResolvedValueOnce({ partnerId: 'p1', events: 0, tasks: 0 });
    expect((await post(UUID, { received: TODAY })).status).toBe(200);
    expect(JSON.parse(String(sent[1].params?.[2]))).toEqual({ received: TODAY, ticket: null, partner_id: 'p1' });
  });

  it('не uuid или карточки нет — 404, журнала нет', async () => {
    expect((await post('x', BASIS)).status).toBe(404);
    expect(eraseCrmContactOnRequest).not.toHaveBeenCalled();
    eraseCrmContactOnRequest.mockResolvedValueOnce(null);
    expect((await post(UUID, BASIS)).status).toBe(404);
    expect(sent.map((q) => q.text)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('стёрто — в той же транзакции запись журнала: кто, какая карточка, дата и номер обращения; ответ без ПД', async () => {
    eraseCrmContactOnRequest.mockResolvedValueOnce({ partnerId: 'p1', events: 3, tasks: 1 });
    const r = await post(UUID, { received: TODAY, ticket: ' 17 ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, data: { events: 3, tasks: 1 } });
    expect(sent.map((q) => q.text.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'COMMIT']);
    const audit = sent[1];
    expect(audit.text).toMatch(/INSERT INTO audit_logs/);
    expect(audit.params?.slice(0, 2)).toEqual(['admin-1', UUID]);
    expect(JSON.parse(String(audit.params?.[2]))).toEqual({ received: TODAY, ticket: '17', partner_id: 'p1' });
  });

  it('журнал не записался — откат и 503: без записи в журнале стирания нет', async () => {
    eraseCrmContactOnRequest.mockResolvedValueOnce({ partnerId: 'p1', events: 0, tasks: 0 });
    failOn = /INSERT INTO audit_logs/;
    expect((await post(UUID, BASIS)).status).toBe(503);
    expect(sent.map((q) => q.text.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
  });
});
