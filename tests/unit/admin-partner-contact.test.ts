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

import { adminContactView } from '@/lib/partners/admin-contact';
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
    const view = adminContactView({ website: 'https://own.test', email: '  ' }, LAGUNA_CONTACTS, 'https://column.test');
    expect(view.website).toBe('https://own.test');
    expect(view.email).toBe('prokatlaguna@yandex.ru');
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
