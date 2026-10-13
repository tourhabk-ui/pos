/**
 * Модерация отзывов о маршрутах и местах (/hub/admin/content/reviews) и
 * алерт «всплеск плохих отзывов» — разбор 13.10 («как туристы оставляют
 * отзывы?»).
 *
 * Экран не открывался ни разу: читал data.data вместо data.reviews,
 * camelCase-поля, которых API не отдаёт, и слал verified= вместо status=;
 * отказ глушился пустым catch и выглядел как «отзывов нет». Поиск в API
 * ссылался на таблицу t, которой в запросе нет (42P01). Алерт читал
 * `reviews` (uuid маршрута) вместо `operator_tour_reviews` (bigint тура):
 * 42883 на каждом прогоне — сработать не мог ни разу.
 *
 * Судится рендером и вызовом (CLAUDE.md, 13.10): что видит админ, какой
 * адрес уходит в API, что отвечает проба алерта на данных.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin-1' })) }));
vi.mock('@/lib/loyalty/loyalty-system', () => ({ loyaltySystem: { awardPhotoBonusIfEligible: vi.fn(async () => undefined) } }));

import { NextRequest } from 'next/server';
import ReviewsManagement from '@/app/hub/admin/content/reviews/page';
import { toAdminReview } from '@/app/hub/admin/content/reviews/review-row';
import { getAdminAlerts } from '@/lib/admin/alerts';
import { GET as listReviews } from '@/app/api/admin/content/reviews/route';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const API_ROW = {
  id: 'r-1',
  user_id: 'u-1',
  tour_id: 'ark-1',
  rating: '2',
  comment: 'Тропа размыта после дождей',
  is_verified: false,
  created_at: '2026-10-12T05:00:00Z',
  user_name: 'Анна',
  subject_name: 'Вулкан Авачинский',
};

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const listUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/admin/content/reviews?'));

beforeEach(() => {
  fetchMock.mockReset();
  queryMock.mockReset();
});

describe('экран модерации отзывов', () => {
  it('строки из ответа API видны: кто, о чём, что написал', async () => {
    fetchMock.mockImplementation(() => ok({
      success: true,
      data: { reviews: [API_ROW], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } },
    }));
    render(<ReviewsManagement />);

    expect(await screen.findByText('Вулкан Авачинский')).toBeTruthy();
    expect(screen.getByText('Анна')).toBeTruthy();
    expect(screen.getByText('Тропа размыта после дождей')).toBeTruthy();
    expect(screen.getByText('Одобрить')).toBeTruthy();
    expect(screen.queryByText('Отзывы не найдены')).toBeNull();
  });

  it('фильтр «На модерации» уходит в API как status=unverified, «Одобренные» — status=verified', async () => {
    fetchMock.mockImplementation(() => ok({ success: true, data: { reviews: [], pagination: { totalPages: 1 } } }));
    render(<ReviewsManagement />);
    await waitFor(() => expect(listUrls()).toHaveLength(1));
    expect(listUrls()[0]).not.toMatch(/status=|verified=/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'false' } });
    await waitFor(() => expect(listUrls()).toHaveLength(2));
    expect(new URL(listUrls()[1], 'https://x').searchParams.get('status')).toBe('unverified');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'true' } });
    await waitFor(() => expect(listUrls()).toHaveLength(3));
    expect(new URL(listUrls()[2], 'https://x').searchParams.get('status')).toBe('verified');
  });

  it('отказ API — «не загрузились» с причиной, а не «отзывов нет»', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'Ошибка при получении отзывов' }),
    }));
    render(<ReviewsManagement />);

    expect(await screen.findByText('Отзывы не загрузились')).toBeTruthy();
    expect(screen.getByText(/Ошибка при получении отзывов/)).toBeTruthy();
    expect(screen.queryByText('Отзывы не найдены')).toBeNull();
  });

  it('пустой список при ответе 200 — честное «не найдены»', async () => {
    fetchMock.mockImplementation(() => ok({ success: true, data: { reviews: [], pagination: { totalPages: 1 } } }));
    render(<ReviewsManagement />);
    expect(await screen.findByText('Отзывы не найдены')).toBeTruthy();
  });

  it('строка ответа: без имени — «Аноним», без предмета — прочерк, оценка числом', () => {
    const r = toAdminReview({ ...API_ROW, user_name: null, subject_name: null, rating: '4' });
    expect(r).toMatchObject({ userName: 'Аноним', subjectName: '—', rating: 4, isVerified: false });
  });
});

describe('API списка: поиск', () => {
  /** Псевдонимы таблиц, на которые ссылается WHERE, обязаны быть в FROM/JOIN этого же запроса. */
  const unjoinedAliases = (sql: string): string[] => {
    const where = sql.slice(sql.indexOf('WHERE'));
    const used = new Set([...where.matchAll(/\b([a-z]{1,3})\.[a-z_]+/g)].map((m) => m[1]));
    const declared = new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+\w+\s+([a-z]{1,3})\b/g)].map((m) => m[1]));
    return [...used].filter((a) => !declared.has(a));
  };

  it('поиск по названию маршрута или места: и счёт, и список ссылаются только на соединённые таблицы', async () => {
    queryMock.mockImplementation(async (sql: string) => (
      /COUNT\(\*\)/.test(sql) ? { rows: [{ count: '1' }] } : { rows: [API_ROW] }
    ));
    const res = await listReviews(new NextRequest('https://vedarai.ru/api/admin/content/reviews?search=Авач&status=unverified'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.reviews).toHaveLength(1);

    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const [sql, params] of queryMock.mock.calls as Array<[string, unknown[]]>) {
      expect(unjoinedAliases(sql), sql).toEqual([]);
      expect(sql).toMatch(/kr\.title ILIKE \$1 OR pl\.name ILIKE \$1/);
      expect(params[0]).toBe('%Авач%');
    }
  });

  it('отказ базы — 500 и строка в логе с SQLSTATE, а не молчание', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(Object.assign(new Error('missing FROM-clause entry for table "t"'), { code: '42P01' }));
    const res = await listReviews(new NextRequest('https://vedarai.ru/api/admin/content/reviews?search=x'));
    expect(res.status).toBe(500);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sqlstate=42P01'), expect.any(String));
    err.mockRestore();
  });
});

describe('алерт «всплеск плохих отзывов»', () => {
  it('читает отзывы о ТУРАХ, без скрытых, и ведёт на их экран', async () => {
    queryMock.mockImplementation(async (sql: string) => (
      /HAVING COUNT\(\*\) >= 3/.test(sql)
        ? { rows: [{ tour_name: 'Авачинский перевал', bad_reviews: '3' }] }
        : { rows: [] }
    ));
    const alerts = await getAdminAlerts();

    const sql = String(queryMock.mock.calls.find((c) => /HAVING COUNT\(\*\) >= 3/.test(String(c[0])))?.[0]).replace(/\s+/g, ' ');
    expect(sql).toContain('FROM operator_tour_reviews r JOIN operator_tours t ON r.tour_id = t.id');
    expect(sql).toContain('r.is_hidden = FALSE');
    expect(sql).not.toMatch(/FROM reviews\b/);

    const burst = alerts.find((a) => /Авачинский перевал/.test(a.message));
    expect(burst).toMatchObject({ actionUrl: '/hub/admin/content/tour-reviews' });
  });
});
