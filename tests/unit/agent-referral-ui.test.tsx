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
  clicks: 5, conversions: 2, commission_rate: '10', earned_total: '2000',
  is_active: true, created_at: '2026-07-01',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: [LINK], stats: { totalClicks: 5, totalConversions: 2, totalEarned: 2000 } }),
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
    expect(screen.getByText('Все туры · 10%')).toBeTruthy();
    expect(screen.getByText(/5 кликов · 2 бронь/)).toBeTruthy();
    // статистика заработка (ru-RU, узкий пробел)
    expect(screen.getAllByText(/2\s*000/).length).toBeGreaterThan(0);
  });
});
