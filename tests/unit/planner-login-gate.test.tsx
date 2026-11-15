/**
 * Планер — только после входа (слово владельца 14.11: «6 хранить в лк»,
 * «6-3» — без входа планер не работает; «нужно ограничивать пользователей
 * без регистрации»).
 *
 * Страница /planner рендерится с подложенной проверкой сессии: вошёл —
 * планер; не вошёл или вышел — экран входа с возвратом в планер; не смогли
 * проверить — «не смогли проверить вход», а не «вы не вошли» (§4.0).
 * Адреса API — tests/unit/planner-api-login.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

const { cookie, verifyMock } = vi.hoisted(() => ({ cookie: { v: null as string | null }, verifyMock: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'auth_token' && cookie.v ? { value: cookie.v } : undefined) }),
}));
vi.mock('@/lib/auth/jwt', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/jwt')>()), verifySessionToken: verifyMock }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/app/planner/_PlannerClient', () => ({
  PlannerClient: ({ initialUserId }: { initialUserId?: string | null }) => <div data-testid="planner">планер для {initialUserId}</div>,
}));

import PlannerPage, { metadata } from '@/app/planner/page';
import { safePlannerReturn, plannerLoginHref } from '@/lib/planner/login-gate';

beforeEach(() => { cookie.v = null; verifyMock.mockReset(); });
afterEach(cleanup);

async function page() {
  render(await PlannerPage());
}

describe('страница /planner', () => {
  it('без входа — экран входа с возвратом в планер; планера нет', async () => {
    await page();
    expect(screen.queryByTestId('planner')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Планер поездки — после входа' })).toBeTruthy();
    expect(screen.getByText(/План поездки хранится в личном кабинете/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Войти/ }).getAttribute('href')).toBe('/auth/login?next=%2Fplanner');
    expect(screen.getByRole('link', { name: /Зарегистрироваться/ }).getAttribute('href')).toBe('/auth/login?mode=register&next=%2Fplanner');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('вышел (сессия закрыта) — тот же экран входа', async () => {
    cookie.v = 'tok';
    verifyMock.mockResolvedValue({ status: 'invalid' });
    await page();
    expect(screen.queryByTestId('planner')).toBeNull();
    expect(screen.getByRole('link', { name: /Войти/ })).toBeTruthy();
  });

  it('не смогли проверить вход — так и сказано, планер не открыт, «войдите» не предлагается', async () => {
    cookie.v = 'tok';
    verifyMock.mockResolvedValue({ status: 'unchecked' });
    await page();
    expect(screen.queryByTestId('planner')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Не смогли проверить вход' })).toBeTruthy();
    expect(screen.getByText(/Это не значит, что вы не вошли/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Войти/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Обновить/ }).getAttribute('href')).toBe('/planner');
  });

  it('вошёл — планер с его id', async () => {
    cookie.v = 'tok';
    verifyMock.mockResolvedValue({ status: 'valid', payload: { userId: 'u-7', email: 'x', role: 'tourist' } });
    await page();
    expect(screen.getByTestId('planner').textContent).toBe('планер для u-7');
    expect(screen.queryByRole('link', { name: /Войти/ })).toBeNull();
  });

  it('поисковику страница не отдаётся: за входом индексировать нечего', () => {
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

describe('возврат после входа', () => {
  it('только точный путь планера — открытого перенаправления нет', () => {
    expect(safePlannerReturn('/planner')).toBe('/planner');
    for (const bad of [null, undefined, '', '/planner?x=1', '/planner/', '//evil.example/planner', 'https://evil.example/planner', '/hub/admin']) {
      expect(safePlannerReturn(bad), String(bad)).toBeNull();
    }
  });

  it('ссылка входа планера несёт возврат, который экран входа примет', () => {
    const next = new URL(plannerLoginHref(), 'https://vedarai.ru').searchParams.get('next');
    expect(safePlannerReturn(next)).toBe('/planner');
    const reg = new URL(plannerLoginHref('register'), 'https://vedarai.ru');
    expect(reg.searchParams.get('mode')).toBe('register');
    expect(safePlannerReturn(reg.searchParams.get('next'))).toBe('/planner');
  });
});
