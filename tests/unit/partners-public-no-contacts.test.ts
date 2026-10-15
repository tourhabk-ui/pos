/**
 * Публичный GET /api/partners не отдаёт контакты партнёров (152-ФЗ).
 *
 * Замер прода 15.10 (добор аудита архитектуры): на первой странице ответа
 * анониму было 6 адресов почты и 6 телефонов — поле contact целиком, по всем
 * партнёрам, включая физлиц с самостоятельной регистрацией. Сторож — вызовом:
 * что уходит в SQL и что видит аноним.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: queryMock }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn() }));

import { GET } from '@/app/api/partners/route';

const ROW = {
  id: 'p1', name: 'Местечко Камчатка', category: 'operator', description: 'Экскурсии',
  rating: '4.8', review_count: '3', is_verified: true, created_at: '2026-10-01', updated_at: '2026-10-15',
  images: [null], logo_url: null,
  // Даже если база вернёт контакт (старый SELECT), наружу он уйти не должен.
  contact: { email: 'owner@example.ru', phone: '+79000000000' },
};

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ total: '1' }] } : { rows: [ROW] }));
});

const get = (qs = '') => GET(new NextRequest(`https://vedarai.ru/api/partners${qs}`));

describe('GET /api/partners — без контактов, только публичные карточки', () => {
  it('в ответе нет поля contact, нет почты и телефона', async () => {
    const res = await get();
    const body = await res.json() as { data: { data: Array<Record<string, unknown>> } };
    const item = body.data.data[0];
    expect(item.name).toBe('Местечко Камчатка');
    expect('contact' in item).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/@/);
    expect(raw).not.toMatch(/\+7\d{10}/);
  });

  it('контакт не выбирается из базы, отбор — по публичности карточки', async () => {
    await get();
    const listSql = queryMock.mock.calls.map((c) => String(c[0])).find((s) => !/COUNT\(\*\)/.test(s)) ?? '';
    const countSql = queryMock.mock.calls.map((c) => String(c[0])).find((s) => /COUNT\(\*\)/.test(s)) ?? '';
    expect(listSql).not.toMatch(/\bcontact\b/);
    expect(listSql).toMatch(/is_public = true/);
    expect(countSql).toMatch(/is_public = true/);
  });

  it('limit ограничен: выгрузить всех разом нельзя; мусор вместо числа — умолчание', async () => {
    await get('?limit=100000&page=abc');
    const listCall = queryMock.mock.calls.find((c) => !/COUNT\(\*\)/.test(String(c[0])))!;
    const params = listCall[1] as unknown[];
    expect(params[params.length - 2]).toBe(50);
    expect(params[params.length - 1]).toBe(0);
  });
});
