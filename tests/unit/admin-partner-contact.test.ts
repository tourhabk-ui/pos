/**
 * Контакты в форме «Редактирование партнёра» (владелец 23.10, снимок формы
 * «Лагуны Прокат»: «почему сайт не заполнен?»). Миграция 1318 положила сайт,
 * почту и адрес в partners.contacts (блок связи витрины), а форма читала только
 * partners.contact, где был один телефон.
 *
 * Судится вызовом: правило adminContactView на граничных данных и ответ
 * GET /api/admin/content/partners/[id] на строке «Лагуны» — поля приходят
 * заполненными, своё значение contact главнее, чего нет нигде — пусто.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin', role: 'admin' }) }));

import { adminContactView, websiteWrite } from '@/lib/partners/admin-contact';
import { GET } from '@/app/api/admin/content/partners/[id]/route';

const LAGUNA_CONTACTS = {
  phone: '+79060835070',
  telegram_contact: '+79060835070',
  email: 'prokatlaguna@yandex.ru',
  website: 'https://лагунапрокат.рф/',
};

describe('adminContactView', () => {
  it('пустые поля contact дополняются из contacts; сайт — ещё и из колонки website', () => {
    expect(adminContactView({ phone: '+79060835070' }, LAGUNA_CONTACTS, null)).toMatchObject({
      phone: '+79060835070', email: 'prokatlaguna@yandex.ru', website: 'https://лагунапрокат.рф/',
    });
    expect(adminContactView({}, {}, 'https://example.test')).toMatchObject({ website: 'https://example.test' });
  });

  it('своё значение contact главнее; пустая строка — не значение', () => {
    const view = adminContactView({ phone: '+70000000000', email: '  ' }, LAGUNA_CONTACTS, 'https://column.test');
    expect(view.phone).toBe('+70000000000');
    expect(view.email).toBe('prokatlaguna@yandex.ru');
  });

  it('сайт — сперва тот, что на витрине: его меняет оператор в кабинете, а регистрация пишет contact', () => {
    // Оператор зарегистрировался с old-site, потом сменил сайт в кабинете.
    expect(adminContactView({ website: 'https://old-site.ru' }, { website: 'https://new-site.ru' }, null).website).toBe('https://new-site.ru');
    expect(adminContactView({ website: 'https://own.test' }, {}, 'https://column.test').website).toBe('https://own.test');
    expect(adminContactView({ website: '  ' }, [], 'https://column.test').website).toBe('https://column.test');
    expect(adminContactView({ website: '  ' }, {}, null)).not.toHaveProperty('website');
  });

  it('чего нет нигде — поля нет; мусор вместо объекта не роняет', () => {
    expect(adminContactView(null, 'строка', null)).toEqual({});
    expect(adminContactView([1, 2], [3], 42)).toEqual({});
  });
});

describe('GET /api/admin/content/partners/[id]', () => {
  beforeEach(() => queryMock.mockReset());

  it('строка «Лагуны» (контакты в contacts) отдаёт форме сайт и почту', async () => {
    queryMock.mockResolvedValue({ rows: [{
      id: 'p-1', user_id: null, name: 'Лагуна Прокат', category: 'transfer', description: null, short_description: null,
      slug: 'laguna-prokat', hero_image: null, logo_image: null, location: { address: 'с. Паратунка' }, is_public: true,
      contact: { phone: '+79060835070' }, contacts: LAGUNA_CONTACTS, website: null,
      rating: '0', review_count: '0', is_verified: false, created_at: '2026-10-23', updated_at: '2026-10-23',
    }] });
    const res = await GET(new Request('http://x/api/admin/content/partners/p-1') as never, { params: Promise.resolve({ id: 'p-1' }) });
    const body = await res.json() as { data: { contact: Record<string, string> } };
    expect(body.data.contact).toMatchObject({ phone: '+79060835070', email: 'prokatlaguna@yandex.ru', website: 'https://лагунапрокат.рф/' });
    // Колонки, из которых дополняется форма, читаются тем же запросом.
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/\bcontacts\b/);
    expect(sql).toMatch(/\bwebsite\b/);
  });
});

describe('websiteWrite — поменял ли администратор сайт', () => {
  const row = { contact: { website: 'https://old-site.ru' }, contacts: { website: 'https://new-site.ru' }, website: null };

  it('сохранение без правки сайта его не пишет — правка оператора не откатывается', () => {
    expect(websiteWrite(row, 'https://new-site.ru')).toEqual({ changed: false });
    expect(websiteWrite(row, '  https://new-site.ru ')).toEqual({ changed: false });
  });

  it('новый сайт — пишется; пустое поле — снимает сайт', () => {
    expect(websiteWrite(row, 'https://third.ru')).toEqual({ changed: true, value: 'https://third.ru' });
    expect(websiteWrite(row, '')).toEqual({ changed: true, value: null });
    expect(websiteWrite({ contact: {}, contacts: {}, website: null }, '')).toEqual({ changed: false });
  });
});

describe('PUT /api/admin/content/partners/[id]: сайт — во все три места, только если поменян', () => {
  beforeEach(() => queryMock.mockReset());

  const put = async (website: string, current: Record<string, unknown> = { contact: { phone: '+79060835070' }, contacts: LAGUNA_CONTACTS, website: null }) => {
    queryMock.mockImplementation(async (sql: string) => (/^SELECT contact, contacts, website/.test(sql)
      ? { rows: [current], rowCount: 1 }
      : { rows: [{ id: 'p-1' }], rowCount: 1 }));
    const { PUT } = await import('@/app/api/admin/content/partners/[id]/route');
    const res = await PUT(new Request('http://x/api/admin/content/partners/p-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Лагуна Прокат', contact: { phone: '+79060835070', website } }),
    }) as never, { params: Promise.resolve({ id: 'p-1' }) });
    const update = queryMock.mock.calls.find((c) => String(c[0]).startsWith('UPDATE partners'));
    return { status: res.status, sql: String(update?.[0] ?? ''), values: (update?.[1] ?? []) as unknown[] };
  };

  it('поменянный сайт пишется в колонку website и в блок связи витрины contacts', async () => {
    const { status, sql, values } = await put(' https://другой-сайт.рф/ ');
    expect(status).toBe(200);
    expect(sql).toMatch(/\bwebsite = \$\d+/);
    expect(sql).toMatch(/jsonb_set\([\s\S]*'\{website\}'/);
    expect(values.filter((v) => v === 'https://другой-сайт.рф/')).toHaveLength(2);
  });

  it('сайт не трогали — ни колонка website, ни contacts не переписываются', async () => {
    const { status, sql } = await put('https://лагунапрокат.рф/');
    expect(status).toBe(200);
    expect(sql).not.toMatch(/\bwebsite = /);
    expect(sql).not.toMatch(/contacts = /);
  });

  it('пустое поле снимает сайт везде, а не оставляет старый в витрине', async () => {
    const { sql, values } = await put('');
    expect(sql).toMatch(/- 'website'/);
    expect(values.filter((v) => v === null).length).toBeGreaterThanOrEqual(2);
  });

  it('партнёра нет — 404 до записи', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const { PUT } = await import('@/app/api/admin/content/partners/[id]/route');
    const res = await PUT(new Request('http://x', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', contact: {} }),
    }) as never, { params: Promise.resolve({ id: 'p-404' }) });
    expect(res.status).toBe(404);
    expect(queryMock.mock.calls.some((c) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
});
