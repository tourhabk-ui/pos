/**
 * На телефоне радар /safety должен быть на первом экране (слово владельца
 * после PR #3720): карточка уведомлений ниже радара, не выше.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import SafetyClient from '@/app/safety/_SafetyClient';
import type { SafetyLiveData } from '@/app/_home/data';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/safety',
}));

const LIVE: SafetyLiveData = {
  safety: { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null },
  seismic: { events: [], source: 'none', updatedAt: null, checkedAt: null },
  radar: {
    hazards: [],
    center: { lat: 53.02, lng: 158.65, label: 'Петропавловск-Камчатский' },
  },
  volcanoes: { items: [], updatedAt: null, checkedAt: null, degraded: false },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('/safety — радар на первом экране', () => {
  it('радар рендерится раньше карточки уведомлений, строки «обстановка обновляется» над ним нет', () => {
    const { container } = render(<SafetyClient live={LIVE} />);
    const html = container.innerHTML;
    const radarAt = html.indexOf('Радар обстановки');
    const offerAt = html.indexOf('Предупреждения о безопасности');
    expect(radarAt).toBeGreaterThan(0);
    expect(offerAt).toBeGreaterThan(radarAt);
    expect(html).not.toContain('Камчатка · обстановка обновляется автоматически');
  });
});
