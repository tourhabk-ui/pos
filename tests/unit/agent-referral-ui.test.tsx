/**
 * tests/unit/agent-referral-ui.test.tsx
 *
 * Клиент реферальных ссылок агента: рендерит статистику и список ссылок
 * из GET /api/hub/agent/referral.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import ReferralClient from '@/app/hub/agent/referral/_ReferralClient';

const LINK = {
  id: 'l1', code: 'KH-AGT-ABC', tour_id: null, tour_title: null,
  clicks: 5, conversions: 2, paid_sales: 1, earned_total: 2000,
  is_active: true, created_at: '2026-07-01',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: [LINK], stats: { totalClicks: 5, totalConversions: 2, totalEarned: 2000, rate: 10 } }),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReferralClient', () => {
  it('рендерит статистику и ссылку с конверсиями', async () => {
    render(<ReferralClient />);
    await waitFor(() => expect(screen.getByText('KH-AGT-ABC')).toBeTruthy());
    expect(screen.getByText('Все туры')).toBeTruthy();
    expect(screen.getByText(/5 кликов · 2 бронь\(и\), оплачено 1/)).toBeTruthy();
    expect(screen.getByText(/Ваша ставка: 10%/)).toBeTruthy();
    // статистика заработка (ru-RU, узкий пробел)
    expect(screen.getAllByText(/2\s*000/).length).toBeGreaterThan(0);
  });

  it('без ставки агента — слова, а не «0 ₽»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [{ ...LINK, earned_total: null }],
        stats: { totalClicks: 5, totalConversions: 2, totalEarned: null, rate: null },
      }),
    }));
    render(<ReferralClient />);
    await waitFor(() => expect(screen.getByText('KH-AGT-ABC')).toBeTruthy());
    expect(screen.getByText('ставка не назначена')).toBeTruthy();
    expect(screen.getByText(/заработок не считается: ставка не назначена/)).toBeTruthy();
    expect(screen.queryByText(/^0\s*₽$/)).toBeNull();
  });
});
