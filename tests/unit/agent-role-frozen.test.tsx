/**
 * Роль агента заморожена, пока Ведар не принимает оплату (#3212, слово
 * владельца 10.11). Сторож судит то, что видит человек, — рендер каждого
 * экрана кабинета агента и страницы регистрации в двух режимах:
 *
 *  - оплата выключена (как на проде): агента нет среди ролей регистрации,
 *    сверху кабинета строка о заморозке, и ни один экран не обещает
 *    вознаграждения — ни плиткой, ни столбцом, ни подписью, ни разделом,
 *    в том числе «Комиссии» и «Рефералы» по прямому адресу;
 *  - оплата включена (в тесте): всё возвращается без правок кода роли.
 *
 * Выключатель подменяется здесь, а правило роли — настоящее
 * (`agentRoleOpen()` из lib/auth/agent-role): так сторож держит и то, что
 * роль открывается ровно флагом оплаты.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';

const payments = vi.hoisted(() => ({ accepts: false }));
vi.mock('@/lib/payments/accepting', () => ({
  PLATFORM_ACCEPTS_PAYMENTS: false,
  platformAcceptsPayments: () => payments.accepts,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: vi.fn(), completeMfaSignIn: vi.fn() }),
  MfaRequiredError: class extends Error {},
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('date_from=2026-12-01'),
  usePathname: () => '/hub/agent',
}));
vi.mock('@/app/auth/login/_TelegramLoginButton', () => ({ default: () => null }));
vi.mock('@/app/auth/login/_MaxLoginButton', () => ({ default: () => null }));
// Оболочка кабинета: пункты меню — текстом, чтобы судить их наличие.
vi.mock('@/components/layout/HubLayout', () => ({
  HubLayout: ({ sidebarItems, children }: { sidebarItems: Array<{ label: string }>; children: ReactNode }) => (
    <div>
      <nav>{sidebarItems.map((i) => <span key={i.label}>{i.label}</span>)}</nav>
      {children}
    </div>
  ),
}));
vi.mock('@/components/hub/PartnerChannelBanner', () => ({ PartnerChannelBanner: () => null }));
vi.mock('@/components/hub/usePartnerOnboarding', () => ({ useOnboardingGuard: () => true }));
vi.mock('@/components/auth/Protected', () => ({ Protected: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/marketplace/TourDateField', () => ({ default: () => null }));
vi.mock('@/app/hub/agent/commissions/_AgentCommissionsPageClient', () => ({ default: () => <p>Комиссии: начисления</p> }));
vi.mock('@/app/hub/agent/referral/_ReferralClient', () => ({ default: () => <p>Рефералы: ссылки и заработок</p> }));

import AuthPageClient from '@/app/auth/login/_AuthPageClient';
import AgentHubLayout from '@/app/hub/agent/layout';
import AgentDashboardClient from '@/app/hub/agent/_AgentDashboardClient';
import FindToursClient from '@/app/hub/agent/find/_FindToursClient';
import AgentBookingsPageClient from '@/app/hub/agent/bookings/_AgentBookingsPageClient';
import StatsClient from '@/app/hub/agent/stats/_StatsClient';
import AgentProfileClient from '@/app/hub/agent/profile/_AgentProfileClient';
import AgentCommissionsPage from '@/app/hub/agent/commissions/page';
import AgentReferralPage from '@/app/hub/agent/referral/page';

// Обещание вознаграждения в любой форме. Строка заморозки («вознаграждение
// не начисляется») сюда не попадает: она говорит обратное.
const PROMISE = /Вознаграждение\b|Ставку (вашего )?вознаграждения|выплату вознаграждения|Комиссия|Комиссии|Начислено|Начисления|Оплаченные продажи|Рефералы/;

function json(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

const DASHBOARD = {
  success: true,
  data: {
    metrics: {
      totalClients: 3, activeClients: 2, totalBookings: 4, unpaidBookings: 1,
      completedBookings: 1, cancelledBookings: 0, paidBookings: 2, paidRevenue: 90000, averageBookingValue: 45000,
    },
    commission: { rate: 10, waiting: 9000, payable: null, requested: 0, paidOut: 0, flagged: 0 },
    upcomingBookings: [{ id: 'b1', clientName: 'Анна П.', tourName: 'Вулкан Горелый', tourDate: '2026-12-20', totalPrice: 45000, commission: 4500 }],
  },
};

function route(url: string) {
  if (url.startsWith('/api/agent/dashboard')) return json(DASHBOARD);
  if (url.startsWith('/api/agent/clients')) return json({ success: true, data: { clients: [] } });
  if (url.startsWith('/api/agent/find-tours')) {
    return json({ success: true, data: [{
      tour_id: 7, title: 'Вулкан Горелый', description: null, activity_type: 'trekking', duration_hours: 8,
      max_participants: 10, difficulty: 'medium', operator_id: 1, operator_name: 'Оператор',
      operator_phone: null, available_date: '2026-12-20', available_spots: 5, price: '45000', price_unit: 'per_person',
    }] });
  }
  if (url.startsWith('/api/agent/bookings')) return json({ success: true, data: { bookings: [] } });
  if (url.startsWith('/api/agent/tours')) return json({ success: true, data: { tours: [] } });
  if (url.startsWith('/api/agent/stats')) {
    return json({ success: true, data: {
      rate: 10, commissions: [{ month: '2026-11', amount: 4500 }], clients: 3, retention: 33, repeatClients: 1,
      topTours: [{ name: 'Вулкан Горелый', bookings: 2 }],
    } });
  }
  if (url.startsWith('/api/partners/profile')) {
    return json({ success: true, data: { partner: { profile_status: 'approved', profile_review_comment: null } } });
  }
  return Promise.reject(new Error(`неожиданный запрос ${url}`));
}

beforeEach(() => {
  payments.accepts = false;
  vi.stubGlobal('fetch', vi.fn((u: string | URL) => route(String(u))));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const text = () => document.body.textContent ?? '';

/** Каждый экран — в обоих режимах: ждёт данных и возвращает видимый текст. */
const SCREENS: Array<{ name: string; show: () => Promise<void> }> = [
  {
    name: 'обзор (плитки, таблица ближайших броней, разделы)',
    show: async () => {
      render(<AgentDashboardClient />);
      await waitFor(() => expect(screen.getAllByText('Вулкан Горелый').length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByText('Средний чек')).toBeTruthy());
    },
  },
  {
    name: 'найти тур',
    show: async () => {
      render(<FindToursClient />);
      await waitFor(() => expect(screen.getByText('Вулкан Горелый')).toBeTruthy());
    },
  },
  {
    name: 'сделки: форма брони за клиента',
    show: async () => {
      render(<AgentBookingsPageClient />);
      fireEvent.click(screen.getByRole('button', { name: /Бронь за клиента/ }));
      await waitFor(() => expect(screen.getByText('Сумма заявки')).toBeTruthy());
    },
  },
  {
    name: 'статистика',
    show: async () => {
      render(<StatsClient />);
      await waitFor(() => expect(screen.getByText('Лучшие туры')).toBeTruthy());
    },
  },
  {
    name: 'профиль (одобрен)',
    show: async () => {
      render(<AgentProfileClient />);
      await waitFor(() => expect(screen.getByText(/Кабинет открыт/)).toBeTruthy());
    },
  },
];

describe('роль агента заморожена: оплата выключена', () => {
  it('регистрация: агента нет среди ролей партнёра, остальные пять на месте', () => {
    render(<AuthPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));
    fireEvent.click(screen.getByText('Партнёр'));
    expect(screen.queryByText('Агент')).toBeNull();
    for (const r of ['Туроператор', 'Гид', 'Трансфер', 'Владелец жилья', 'Прокат снаряжения']) {
      expect(screen.getByText(r), r).toBeTruthy();
    }
  });

  it('кабинет: строка о заморозке сверху, в меню нет «Комиссии» и «Рефералы»', () => {
    render(<AgentHubLayout><p>содержимое</p></AgentHubLayout>);
    expect(screen.getByTestId('agent-frozen-note').textContent)
      .toBe('Роль заморожена: вознаграждение не начисляется, пока Ведар не принимает оплату.');
    expect(screen.queryByText('Комиссии')).toBeNull();
    expect(screen.queryByText('Рефералы')).toBeNull();
    expect(screen.getByText('Сделки')).toBeTruthy();
  });

  for (const s of SCREENS) {
    it(`${s.name}: ни слова о вознаграждении`, async () => {
      await s.show();
      expect(text()).not.toMatch(PROMISE);
    });
  }

  it('комиссии и рефералы по прямому адресу: «раздел закрыт», начислений и ссылок нет', () => {
    render(<AgentCommissionsPage />);
    render(<AgentReferralPage />);
    expect(screen.getAllByTestId('agent-money-closed')).toHaveLength(2);
    expect(screen.getAllByText('Раздел закрыт: роль агента заморожена, вознаграждение не начисляется, пока Ведар не принимает оплату.')).toHaveLength(2);
    expect(screen.queryByText(/начисления|заработок/)).toBeNull();
  });

  it('таблица ближайших броней: сумма брони названа суммой, а не доходом агента', async () => {
    render(<AgentDashboardClient />);
    await waitFor(() => expect(screen.getByText('Сумма брони')).toBeTruthy());
    expect(screen.queryByText('Доход')).toBeNull();
  });
});

describe('оплату открыли: роль агента возвращается без правок кода', () => {
  beforeEach(() => { payments.accepts = true; });

  it('регистрация: агент среди ролей', () => {
    render(<AuthPageClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Регистрация' }));
    fireEvent.click(screen.getByText('Партнёр'));
    expect(screen.getByText('Агент')).toBeTruthy();
  });

  it('кабинет: строки о заморозке нет, «Комиссии» и «Рефералы» в меню', () => {
    render(<AgentHubLayout><p>содержимое</p></AgentHubLayout>);
    expect(screen.queryByTestId('agent-frozen-note')).toBeNull();
    expect(screen.getByText('Комиссии')).toBeTruthy();
    expect(screen.getByText('Рефералы')).toBeTruthy();
  });

  it('комиссии и рефералы по прямому адресу открыты', () => {
    render(<AgentCommissionsPage />);
    render(<AgentReferralPage />);
    expect(screen.queryByTestId('agent-money-closed')).toBeNull();
    expect(screen.getByText('Комиссии: начисления')).toBeTruthy();
    expect(screen.getByText('Рефералы: ссылки и заработок')).toBeTruthy();
  });

  for (const s of SCREENS) {
    it(`${s.name}: вознаграждение снова видно`, async () => {
      await s.show();
      await waitFor(() => expect(text()).toMatch(PROMISE));
    });
  }
});
