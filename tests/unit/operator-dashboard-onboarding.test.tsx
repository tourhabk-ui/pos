/**
 * Шаг «Заполнить профиль» на дашборде берётся из ворот.
 * Менеджер незавершённой компании не видит его выполненным.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import OperatorDashboardClient from '@/app/hub/operator/_OperatorDashboardClient';
import { OperatorCabinetFacts } from '@/components/operator/OperatorCabinetGate';

const DASH = {
  moneyHidden: true,
  metrics: {
    totalTours: 0, activeTours: 0, totalBookings: 0, pendingBookings: 0,
    confirmedBookings: 0, completedBookings: 0, cancelledBookings: 0,
    totalRevenue: null, monthlyRevenue: null, paidRevenue: null, paidRevenueMonth: null,
    averageRating: null, totalReviews: 0, newLeadsToday: 0, newLeadsWeek: 0, unprocessedLeads: 0,
  },
  recentBookings: [],
  topTours: [],
  revenueChart: [],
  bookingsChart: [],
  upcomingTours: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(facts: { onboardingCompleted: boolean; viewer: 'owner' | 'manager' } | null) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/operator/dashboard')) {
      return { ok: true, json: async () => ({ success: true, data: DASH }) };
    }
    return { ok: false, json: async () => ({ success: false, error: 'нет' }) };
  }));
  const node = <OperatorDashboardClient />;
  return render(
    facts
      ? <OperatorCabinetFacts.Provider value={facts}>{node}</OperatorCabinetFacts.Provider>
      : node,
  );
}

describe('первые шаги и черновик профиля', () => {
  it('менеджер незавершённой компании не видит профиль заполненным', async () => {
    mount({ onboardingCompleted: false, viewer: 'manager' });
    const label = await screen.findByText('Заполнить профиль компании');
    expect(label.style.textDecoration).toBe('none');
    expect(screen.getByRole('link', { name: /Кто заполняет/ }).getAttribute('href')).toBe('/hub/operator/onboarding');
    expect(screen.getByText('Это делает владелец компании')).toBeTruthy();
  });

  it('завершённая настройка отмечена выполненной', async () => {
    mount({ onboardingCompleted: true, viewer: 'owner' });
    const label = await screen.findByText('Заполнить профиль компании');
    expect(label.style.textDecoration).toBe('line-through');
    expect(screen.queryByRole('link', { name: /Заполнить$/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Кто заполняет/ })).toBeNull();
  });
});
