/**
 * Вход на сайт через MAX или Telegram для карточки партнёра (владелец 26.10:
 * прокатчику «Лагуны» нужен кабинет на сайте, почты у человека нет, MAX есть).
 *
 * Сквозной путь на настоящей базе — ссылка op_ в диалоге, кнопка
 * администратора, «Войти через MAX» и кабинет перевозчика — держит
 * tests/integration/max-login-confirm.pg.test.ts. Здесь — то, что там не
 * проходится: двери роута (не администратор, не uuid, сбой базы), отказы
 * «карточки нет», «категории без кабинета», «уже владелец другой карточки»,
 * вход через Telegram и то, что видит администратор на карточке.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { connect: async () => ({ query: m.query, release: m.release }) } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: m.requireAdmin }));
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import { POST } from '@/app/api/admin/operators/[id]/messenger-login/route';
import { OperatorCard } from '@/app/hub/admin/operators/_OperatorsClient';

const PID = '0aaa4f05-0000-4000-8000-0000000000aa';

type Card = { name: string; category: string; user_id: string | null; max_owner_user_id: string | null; telegram_owner_user_id: string | null };
type User = { id: string; role: string; preferences: unknown };

/** База на подмене: карточка, найденный по мессенджеру аккаунт и чья ещё карточка у него. */
function db(card: Card | null, user: User | null = null, ownsOther = false) {
  m.query.mockImplementation(async (sql: string) => {
    if (/FROM partners WHERE id = \$1::uuid FOR UPDATE/.test(sql)) return { rows: card ? [card] : [] };
    if (/FROM users WHERE (max_user_id|telegram_id) = \$1::bigint FOR UPDATE/.test(sql)) return { rows: user ? [user] : [] };
    if (/FROM partners WHERE user_id = \$1::uuid/.test(sql)) return { rows: ownsOther ? [{ id: 'other' }] : [] };
    if (/INSERT INTO users/.test(sql)) return { rows: [{ id: 'u-new' }] };
    return { rows: [] };
  });
}

const card = (over: Partial<Card> = {}): Card => ({
  name: 'Лагуна Прокат', category: 'transfer', user_id: null, max_owner_user_id: null, telegram_owner_user_id: null, ...over,
});

async function call(id = PID) {
  const res = await POST(
    new NextRequest(`https://vedarai.ru/api/admin/operators/${id}/messenger-login`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const sent = () => m.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0]);

beforeEach(() => {
  m.query.mockReset();
  m.release.mockReset();
  m.requireAdmin.mockReset();
  m.requireAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('роут: двери', () => {
  it('не администратор — его ответ, к базе не идём', async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    expect((await call()).status).toBe(403);
    expect(m.query).not.toHaveBeenCalled();
  });

  it('не uuid в адресе — 400, к базе не идём', async () => {
    expect((await call('42')).status).toBe(400);
    expect(m.query).not.toHaveBeenCalled();
  });

  it('база упала — 503 и откат; в логе SQLSTATE, без id человека', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.query.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) throw Object.assign(new Error('boom 730001'), { code: '57014' });
      return { rows: [] };
    });
    const r = await call();
    expect(r.status).toBe(503);
    expect(sent()).toContain('ROLLBACK');
    expect(sent()).not.toContain('COMMIT');
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).toContain('57014');
    expect(logged).not.toContain('730001');
    expect(m.release).toHaveBeenCalled();
  });
});

describe('роут: отказы называют причину и ничего не пишут', () => {
  it.each([
    ['карточки нет', null, null, false, 404, 'not_found', /не найдена/],
    ['аккаунт уже есть', card({ user_id: 'u-1' }), null, false, 409, 'has_account', /уже есть аккаунт/],
    ['категория без кабинета', card({ category: 'hotel', max_owner_user_id: '1' }), null, false, 409, 'no_role', /кабинета на сайте нет/],
    ['ссылку никто не открыл', card(), null, false, 409, 'no_opener', /открыть ссылку подключения/],
    ['человек — администратор', card({ max_owner_user_id: '7' }), { id: 'u-7', role: 'tourist', preferences: { roles: ['tourist', 'admin'] } }, false, 409, 'other_role', /другой ролью/],
    ['человек — владелец другой карточки', card({ max_owner_user_id: '7' }), { id: 'u-7', role: 'tourist', preferences: null }, true, 409, 'owns_other_card', /другой карточки/],
  ] as const)('%s', async (_name, c, u, owns, status, outcome, text) => {
    db(c, u, owns);
    const r = await call();
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ success: false, outcome });
    expect(String(r.body.error)).toMatch(text);
    expect(sent()).toContain('ROLLBACK');
    expect(sent()).not.toContain('COMMIT');
    expect(sent().filter((s) => s === 'INSERT' || s === 'UPDATE')).toEqual([]);
  });
});

describe('роут: вход заведён', () => {
  it('через Telegram: аккаунт без пароля и без согласия, адрес-заглушка, карточка получает владельца', async () => {
    db(card({ telegram_owner_user_id: '880001' }));
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, via: 'telegram', created: true });
    expect(String(r.body.message)).toContain('«Войти через Telegram»');
    const insert = m.query.mock.calls.find(([sql]) => /INSERT INTO users/.test(String(sql)))!;
    expect(String(insert[0])).toMatch(/telegram_id, password_hash, is_active, pd_consent_given/);
    expect(String(insert[0])).toMatch(/'', TRUE, FALSE/);
    expect(insert[1]).toEqual(['tg_880001@telegram.local', 'Лагуна Прокат', 'transfer', '880001']);
    const link = m.query.mock.calls.find(([sql]) => /UPDATE partners SET user_id/.test(String(sql)))!;
    expect(String(link[0])).toMatch(/AND user_id IS NULL/);
    expect(link[1]).toEqual([PID, 'u-new']);
    expect(sent()).toContain('COMMIT');
  });

  it('MAX и Telegram открыты оба — вход через MAX', async () => {
    db(card({ max_owner_user_id: '730001', telegram_owner_user_id: '880001' }));
    const r = await call();
    expect(r.body).toMatchObject({ via: 'max' });
    const insert = m.query.mock.calls.find(([sql]) => /INSERT INTO users/.test(String(sql)))!;
    expect(insert[1]).toEqual(['max_730001@max.local', 'Лагуна Прокат', 'transfer', '730001']);
  });
});

describe('карточка в админке', () => {
  type Op = Parameters<typeof OperatorCard>[0]['op'];
  const OP: Op = {
    id: PID, company_name: 'Лагуна Прокат', category: 'transfer', description: '',
    // На проверке — карточка раскрыта сразу.
    profile_status: 'pending', applied_at: null, is_verified: true, is_public: true, profile_review_comment: null,
    email: null, contact_name: null, registered_at: null, has_account: false, external_source: null,
    application_id: null, contact_phone: null, contact_email: null, inn: null, application_status: null,
    reviewed_at: null, telegram_chat_id: null, has_telegram: false, has_max: true, slug: 'laguna-prokat',
    widget_enabled: false, widget_domains: [],
  };
  const fetchMock = vi.fn();
  const answer = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('кнопка заводит вход и показывает, как человеку войти', async () => {
    fetchMock.mockImplementation((url: string) => (String(url).endsWith('/messenger-login')
      ? answer(200, { success: true, via: 'max', message: 'Готово: владелец входит на сайт кнопкой «Войти через MAX»' })
      : answer(200, { success: true })));
    const onAccountCreated = vi.fn();
    render(<OperatorCard op={OP} onApprove={() => {}} onReject={() => {}} onAccountCreated={onAccountCreated} acting={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Вход через MAX / Telegram' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('«Войти через MAX»'));
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/messenger-login'))!;
    expect(post[0]).toBe(`/api/admin/operators/${PID}/messenger-login`);
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(onAccountCreated).toHaveBeenCalledWith(PID, '');
  });

  it('отказ сервера виден словами сервера', async () => {
    fetchMock.mockImplementation((url: string) => (String(url).endsWith('/messenger-login')
      ? answer(409, { success: false, outcome: 'no_opener', error: 'Сначала владелец должен открыть ссылку подключения' })
      : answer(200, { success: true })));
    render(<OperatorCard op={OP} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Вход через MAX / Telegram' }));
    await waitFor(() => expect(screen.getByText(/Сначала владелец должен открыть ссылку подключения/)).toBeTruthy());
  });

  it('аккаунт уже есть — кнопки входа через мессенджер нет', () => {
    fetchMock.mockImplementation(() => answer(200, { success: true }));
    render(<OperatorCard op={{ ...OP, has_account: true }} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />);
    expect(screen.queryByRole('button', { name: 'Вход через MAX / Telegram' })).toBeNull();
  });
});
