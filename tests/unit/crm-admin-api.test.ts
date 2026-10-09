/**
 * Сторож: клиенты всех партнёров у администратора — только просмотр
 * (CRM #2325, решение владельца 09.10).
 *
 * `lib/crm/admin-queries.ts` читает контакты БЕЗ скоупа партнёра — по
 * замыслу, это экран администратора. Поэтому держится и обратное: звать
 * модуль можно только из роутов /api/admin/crm под requireAdmin, а у самих
 * роутов нет обработчиков записи — метки и заметки клиента ведёт партнёр.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const ROOT = process.cwd();

const requireAdmin = vi.fn();
const listAllContacts = vi.fn();
const getContactCardForAdmin = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));
vi.mock('@/lib/crm/admin-queries', () => ({
  listAllContacts: (...a: unknown[]) => listAllContacts(...a),
  getContactCardForAdmin: (...a: unknown[]) => getContactCardForAdmin(...a),
}));

const list = await import('@/app/api/admin/crm/contacts/route');
const one = await import('@/app/api/admin/crm/contacts/[id]/route');

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
  for (const f of [requireAdmin, listAllContacts, getContactCardForAdmin]) f.mockReset();
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
