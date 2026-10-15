/**
 * Настройки виджета партнёра в админке — находка аудита 15.10 WID-config.
 *
 * Было: тумблер «Включён/Выключен» переключался по клику и ответ PATCH не
 * читал — отказ сервера выглядел как успех; сохранение доменов закрывало
 * редактор при любом ответе; сам PATCH на несуществующего оператора отвечал
 * «успех», а widget_config заменял целиком (смена цвета стирала приветствие —
 * это на настоящей базе держит tests/integration/operators-list.pg.test.ts,
 * блок «виджет партнёра»).
 *
 * Судится рендером карточки оператора (что видит администратор после отказа)
 * и вызовом роута (что он отвечает на ноль строк и отказ базы).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin-1', role: 'admin' })) }));
// Панель Tilda грузит свои ключи при монтировании — к виджету отношения не имеет.
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import { OperatorCard } from '@/app/hub/admin/operators/_OperatorsClient';
import { PATCH } from '@/app/api/admin/operators/[id]/widget/route';

type Op = Parameters<typeof OperatorCard>[0]['op'];

const OP: Op = {
  id: '0aaa4f05-0000-4000-8000-000000000001',
  company_name: 'Местечко Камчатка',
  category: 'operator',
  description: '',
  // На проверке — карточка раскрыта сразу.
  profile_status: 'pending',
  applied_at: null,
  is_verified: true,
  is_public: true,
  profile_review_comment: null,
  email: null,
  contact_name: null,
  registered_at: null,
  has_account: false,
  external_source: null,
  application_id: null,
  contact_phone: null,
  contact_email: null,
  inn: null,
  application_status: null,
  reviewed_at: null,
  telegram_chat_id: null,
  has_telegram: false,
  has_max: false,
  slug: 'mestechko',
  widget_enabled: false,
  widget_domains: ['mestechkokam.ru'],
};

const fetchMock = vi.fn();

function renderCard(op: Op = OP) {
  return render(
    <OperatorCard op={op} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />,
  );
}
const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const widgetPatches = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/widget'));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('тумблер виджета верит ответу сервера', () => {
  it('сервер отказал — тумблер возвращается, причина видна', async () => {
    fetchMock.mockImplementation(() => json(500, { error: 'Настройки виджета не сохранены — ошибка базы' }));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Выключен' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Виджет не включён');
    expect(alert.textContent).toContain('ошибка базы');
    expect(screen.getByRole('button', { name: 'Выключен' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Включён' })).toBeNull();
    expect(JSON.parse(String(widgetPatches()[0][1].body))).toEqual({ widget_enabled: true });
  });

  it('связи нет — тоже отказ, а не «Включён»', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Выключен' }));
    expect((await screen.findByRole('alert')).textContent).toContain('нет связи с сервером');
    expect(screen.getByRole('button', { name: 'Выключен' })).toBeTruthy();
  });

  it('сервер принял — «Включён», без строки отказа', async () => {
    fetchMock.mockImplementation(() => json(200, { success: true }));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Выключен' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Включён' })).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('домены не сохранились — редактор остаётся открытым, причина видна', async () => {
    fetchMock.mockImplementation(() => json(404, { error: 'Оператор не найден' }));
    renderCard({ ...OP, widget_enabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Домены не сохранены: Оператор не найден');
    expect(screen.getByRole('button', { name: /Сохранить/ })).toBeTruthy();
  });
});

describe('PATCH /api/admin/operators/[id]/widget называет исход', () => {
  beforeEach(() => { poolQuery.mockReset(); });
  const patch = (body: unknown) => PATCH(
    new NextRequest(`https://vedarai.ru/api/admin/operators/${OP.id}/widget`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: OP.id }) },
  );

  it('конфиг сливается с записанным: в запрос уходят только присланные ключи', async () => {
    poolQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    const res = await patch({ widget_config: { accentColor: '#003466' } });
    expect(res.status).toBe(200);
    const [sql, vals] = poolQuery.mock.calls[0] as [string, unknown[]];
    // Присвоение параметра целиком — замена; слияние — `||` поверх записанного.
    expect(sql).not.toMatch(/widget_config = \$\d+::jsonb/);
    expect(sql).toMatch(/widget_config = .*widget_config.*\|\| \$\d+::jsonb/);
    expect(vals).toContain(JSON.stringify({ accentColor: '#003466' }));
  });

  it('оператора нет — 404, а не «успех»', async () => {
    poolQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await patch({ widget_enabled: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('Оператор не найден');
  });

  it('отказ базы — 500 с причиной по-русски, отказ в логе', async () => {
    const err = Object.assign(new Error('boom'), { code: '22P02' });
    poolQuery.mockRejectedValue(err);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await patch({ widget_enabled: true });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/не сохранены/);
    expect(log.mock.calls.flat().join(' ')).toContain('sqlstate=22P02');
    log.mockRestore();
  });
});
