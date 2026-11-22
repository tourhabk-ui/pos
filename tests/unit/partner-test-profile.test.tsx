/**
 * Тестовый профиль партнёра — не на витрине (миграция 1495, #2770 часть 2,
 * слово владельца 22.11 «да»). Вызовом дверей и рендером, без поиска JSX
 * (CLAUDE.md §4, решение 13.10):
 *
 *  - шлюз витрины туров спрашивает отметку партнёра при любом алиасе, и
 *    без алиаса — полным именем таблицы;
 *  - дверь отметки: только администратор, номер и тело проверены до базы;
 *    отметка снимает карточку с витрины тем же запросом, снятие отметки
 *    витрину не возвращает и так и говорит; отказ базы — 503 с SQLSTATE в
 *    логе, а не «сохранено»;
 *  - правка карточки, ставящая тестовый профиль на витрину, отвечает словами
 *    (409), а не 500; чужой отказ CHECK этими словами не называется;
 *  - кнопка у администратора верит ответу сервера; карточка в списке
 *    помечена «Тест».
 *
 * Что база держит правило на деле — tests/integration/partner-test-profile.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  admin: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => h.query(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => h.admin(...a) }));
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import { publicTourSql } from '@/lib/tours/public-visibility';
import {
  testPartnerTourSql, isTestProfileNotPublicViolation, TEST_PROFILE_CONSTRAINT,
  TEST_PROFILE_NOT_PUBLIC_TEXT, TEST_PROFILE_MARKED_TEXT, TEST_PROFILE_UNMARKED_TEXT,
} from '@/lib/partners/test-profile';
import { PATCH as markTest } from '@/app/api/admin/operators/[id]/test-profile/route';
import { PUT as editPartner } from '@/app/api/admin/content/partners/[id]/route';
import { TestProfileToggle } from '@/components/admin/TestProfileToggle';
import { OperatorCard } from '@/app/hub/admin/operators/_OperatorsClient';

const ID = '0aaa4f05-0000-4000-8000-000000000001';

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.query.mockReset();
  h.admin.mockReset();
  h.admin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('шлюз витрины спрашивает отметку партнёра', () => {
  it('с алиасом, без алиаса (полное имя таблицы) и с отказом на чужом алиасе', () => {
    expect(testPartnerTourSql('ot')).toBe(
      'EXISTS (SELECT 1 FROM partners test_gate WHERE test_gate.id = ot.operator_id AND test_gate.is_test IS TRUE)',
    );
    expect(testPartnerTourSql('')).toContain('test_gate.id = operator_tours.operator_id');
    expect(() => testPartnerTourSql('ot; DROP TABLE partners')).toThrow(/алиас/);
    expect(publicTourSql('t')).toContain(`AND NOT ${testPartnerTourSql('t')})`);
    expect(publicTourSql('')).toContain(`AND NOT ${testPartnerTourSql('')})`);
  });

  it('нарушение именно CHECK тестового профиля узнаётся, чужое — нет', () => {
    expect(isTestProfileNotPublicViolation({ code: '23514', constraint: TEST_PROFILE_CONSTRAINT })).toBe(true);
    expect(isTestProfileNotPublicViolation({ code: '23514', constraint: 'partners_rating_check' })).toBe(false);
    expect(isTestProfileNotPublicViolation({ code: '23505', constraint: TEST_PROFILE_CONSTRAINT })).toBe(false);
    expect(isTestProfileNotPublicViolation(new Error('boom'))).toBe(false);
    expect(isTestProfileNotPublicViolation(null)).toBe(false);
  });
});

describe('PATCH /api/admin/operators/[id]/test-profile', () => {
  const url = `http://localhost/api/admin/operators/${ID}/test-profile`;

  it('не администратор — ответ входа, база не тронута', async () => {
    h.admin.mockResolvedValue(NextResponse.json({ error: 'Нет доступа' }, { status: 403 }));
    const res = await markTest(req(url, 'PATCH', { is_test: true }), params());
    expect(res.status).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('кривой номер и кривое тело — 400 до базы', async () => {
    expect((await markTest(req(url, 'PATCH', { is_test: true }), params('../x'))).status).toBe(400);
    expect((await markTest(req(url, 'PATCH', { is_test: 'yes' }), params())).status).toBe(400);
    expect((await markTest(req(url, 'PATCH'), params())).status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('отметить: тем же запросом карточка уходит с витрины, ответ говорит это словами', async () => {
    h.query.mockResolvedValue({ rows: [{ id: ID, is_test: true, is_public: false }] });
    const res = await markTest(req(url, 'PATCH', { is_test: true }), params());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { is_test: boolean; is_public: boolean }; message: string };
    expect(body.data).toEqual({ id: ID, is_test: true, is_public: false });
    expect(body.message).toBe(TEST_PROFILE_MARKED_TEXT);
    const [sql, args] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/is_public = CASE WHEN \$2 THEN FALSE ELSE is_public END/);
    expect(args).toEqual([ID, true]);
  });

  it('снять: витрина сама не возвращается, и это сказано', async () => {
    h.query.mockResolvedValue({ rows: [{ id: ID, is_test: false, is_public: false }] });
    const body = await (await markTest(req(url, 'PATCH', { is_test: false }), params())).json() as { message: string; data: { is_public: boolean } };
    expect(body.data.is_public).toBe(false);
    expect(body.message).toBe(TEST_PROFILE_UNMARKED_TEXT);
  });

  it('партнёра нет — 404', async () => {
    h.query.mockResolvedValue({ rows: [] });
    expect((await markTest(req(url, 'PATCH', { is_test: true }), params())).status).toBe(404);
  });

  it('отказ базы — 503 словами, в логе SQLSTATE, «сохранено» не говорится', async () => {
    h.query.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    const res = await markTest(req(url, 'PATCH', { is_test: true }), params());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/не сохранена/);
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' '))).toContain('57P01');
  });
});

describe('PUT /api/admin/content/partners/[id]: тестовый профиль на витрину не ставится', () => {
  const url = `http://localhost/api/admin/content/partners/${ID}`;
  const edit = { name: 'Тестовая компания', isPublic: true };

  it('CHECK тестового профиля — 409 словами, а не 500', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ contact: {}, contacts: {}, website: null }] })
      .mockRejectedValueOnce(Object.assign(new Error('violates check constraint'), { code: '23514', constraint: TEST_PROFILE_CONSTRAINT }));
    const res = await editPartner(req(url, 'PUT', edit), params());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(TEST_PROFILE_NOT_PUBLIC_TEXT);
  });

  it('чужой отказ CHECK словами тестового профиля не называется', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ contact: {}, contacts: {}, website: null }] })
      .mockRejectedValueOnce(Object.assign(new Error('violates check constraint'), { code: '23514', constraint: 'partners_rating_check' }));
    const res = await editPartner(req(url, 'PUT', edit), params());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).not.toBe(TEST_PROFILE_NOT_PUBLIC_TEXT);
  });
});

describe('кнопка «тестовый профиль» у администратора', () => {
  it('верит ответу: после отметки — «снять отметку» и слова двери; запрос — PATCH с is_test', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
      calls.push({ url: u, init });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: ID, is_test: true, is_public: false }, message: TEST_PROFILE_MARKED_TEXT }) };
    }));
    render(<TestProfileToggle partnerId={ID} initial={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Отметить тестовым профилем/ }));
    expect((await screen.findByRole('status')).textContent).toBe(TEST_PROFILE_MARKED_TEXT);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button').textContent).toMatch(/снять отметку/);
    expect(calls[0].url).toBe(`/api/admin/operators/${ID}/test-profile`);
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ is_test: true });
  });

  it('отказ сервера — сказано, отметка не нарисована', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'Отметка не сохранена: база не ответила' }) })));
    render(<TestProfileToggle partnerId={ID} initial={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Отметить тестовым профилем/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/не сохранена/);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  });

  it('нет связи — сказано, отметка не нарисована', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<TestProfileToggle partnerId={ID} initial={true} />);
    fireEvent.click(screen.getByRole('button', { name: /снять отметку/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/нет связи/);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });

  it('карточка в списке компаний помечена «Тест» только у тестового профиля', () => {
    type Op = Parameters<typeof OperatorCard>[0]['op'];
    const op: Op = {
      id: ID, company_name: 'Тестовая компания', category: 'operator', description: '',
      profile_status: 'approved', applied_at: null, is_verified: true, is_public: false, is_test: true,
      profile_review_comment: null, email: null, contact_name: null, registered_at: null, has_account: false,
      external_source: null, application_id: null, contact_phone: null, contact_email: null, inn: null,
      application_status: null, reviewed_at: null, telegram_chat_id: null, has_telegram: false, has_max: false,
      slug: 'test-company', widget_enabled: false, widget_domains: [],
    };
    const card = (o: Op) => render(<OperatorCard op={o} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />);
    card(op);
    expect(screen.getByText('Тест')).toBeTruthy();
    cleanup();
    card({ ...op, is_test: false });
    expect(screen.queryByText('Тест')).toBeNull();
  });
});
