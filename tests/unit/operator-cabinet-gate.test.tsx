/**
 * Ворота кабинета: без профиля нет шторма /me и канала,
 * админ не видит «Профиль не найден», незавершённая настройка уходит на онбординг
 * только с главной кабинета — ссылка на заявку или бронь из мессенджера ведёт к ней.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

const path = vi.hoisted(() => ({ value: '/hub/operator' }));
const replace = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => path.value,
  useRouter: () => ({ replace, push: vi.fn() }),
}));

import { OperatorCabinetFacts, OperatorCabinetGate } from '@/components/operator/OperatorCabinetGate';

function FactsProbe() {
  const facts = React.useContext(OperatorCabinetFacts);
  return <p>{facts ? `профиль ${facts.onboardingCompleted ? 'заполнен' : 'не заполнен'}, ${facts.viewer}` : 'фактов нет'}</p>;
}

function mount() {
  return render(
    <OperatorCabinetGate
      quiet={(node) => <div data-testid="quiet">{node}</div>}
      ready={(node) => <div data-testid="ready">{node}</div>}
    >
      <main>экран</main>
    </OperatorCabinetGate>,
  );
}

beforeEach(() => {
  path.value = '/hub/operator';
  replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ворота кабинета оператора', () => {
  it('админ без компании — одна фраза, экран кабинета не монтируется', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/hub/operator/profile');
      return {
        ok: false,
        status: 404,
        json: async () => ({
          success: false,
          code: 'admin_no_company',
          error: 'У этой учётной записи нет кабинета туроператора. Откройте его через «Войти как → Туроператор».',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    mount();
    expect(await screen.findByText(/Войти как → Туроператор/)).toBeTruthy();
    expect(screen.queryByText('экран')).toBeNull();
    expect(screen.queryByTestId('ready')).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every((c) => c[0] === '/api/hub/operator/profile')).toBe(true);
  });

  it('настройка не закончена — тихий переход, дашборд не монтируется', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { onboarding_completed: false } }),
    })));
    mount();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hub/operator/onboarding'));
    expect(screen.queryByText('экран')).toBeNull();
    expect(screen.queryByTestId('ready')).toBeNull();
  });

  it('на странице настройки черновик рисуется без вспышки «не найден»', async () => {
    path.value = '/hub/operator/onboarding';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { onboarding_completed: false } }),
    })));
    mount();
    expect(await screen.findByText('экран')).toBeTruthy();
    expect(screen.queryByText('Профиль не найден')).toBeNull();
    expect(screen.queryByTestId('ready')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('завершённая настройка не возвращает на онбординг по старому ответу', async () => {
    path.value = '/hub/operator/onboarding';
    const completed = { value: false };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { onboarding_completed: completed.value } }),
    })));
    const view = mount();
    expect(await screen.findByText('экран')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();

    completed.value = true;
    path.value = '/hub/operator';
    view.rerender(
      <OperatorCabinetGate
        quiet={(node) => <div data-testid="quiet">{node}</div>}
        ready={(node) => <div data-testid="ready">{node}</div>}
      >
        <main>экран</main>
      </OperatorCabinetGate>,
    );
    expect(await screen.findByTestId('ready')).toBeTruthy();
    expect(screen.getByText('экран')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('менеджер незавершённой компании входит в кабинет, а не на форму владельца', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { onboarding_completed: false, viewer: 'manager' } }),
    })));
    mount();
    expect(await screen.findByText('экран')).toBeTruthy();
    expect(screen.getByTestId('ready')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/владельца компании/)).toBeNull();
  });

  it('менеджер на странице настройки видит, кто её завершает', async () => {
    path.value = '/hub/operator/onboarding';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { onboarding_completed: false, viewer: 'manager' } }),
    })));
    mount();
    expect(await screen.findByText(/Настройку профиля завершает владелец компании/)).toBeTruthy();
    expect(screen.queryByText('экран')).toBeNull();
    expect(screen.getByTestId('ready')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  for (const deep of ['/hub/operator/leads/42', '/hub/operator/bookings/7', '/hub/operator/messages']) {
    it(`настройка не закончена, ссылка из уведомления ${deep} — открывается раздел, а не мастер`, async () => {
      path.value = deep;
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { onboarding_completed: false } }),
      })));
      render(
        <OperatorCabinetGate
          quiet={(node) => <div data-testid="quiet">{node}</div>}
          ready={(node) => <div data-testid="ready">{node}</div>}
        >
          <main>экран</main>
          <FactsProbe />
        </OperatorCabinetGate>,
      );
      expect(await screen.findByText('экран')).toBeTruthy();
      expect(screen.getByTestId('ready')).toBeTruthy();
      // Дашборд и чек-лист не считают профиль заполненным: факт тот же, что у ворот.
      expect(screen.getByText('профиль не заполнен, owner')).toBeTruthy();
      await new Promise((r) => setTimeout(r, 20));
      expect(replace).not.toHaveBeenCalled();
    });
  }
});
