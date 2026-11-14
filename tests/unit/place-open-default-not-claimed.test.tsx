/**
 * Значение по умолчанию не выдаётся за живой статус, незнание — за низкий
 * риск (15.10, §0 «честность»).
 *
 * `location_real_time_status.is_open` проставлен TRUE всем местам при
 * заведении (070/0645): TRUE значит «никто не закрыл», а не «проверили —
 * открыто». Карточка каталога рисовала по нему зелёное мигающее «открыто» на
 * каждом месте. «Анализатор безопасности» начинал оценку с единицы, и место,
 * о котором платформа не знает ничего, получало «1/5 · Низкий риск»; с 14.11
 * своего числа у инструмента нет — он показывает обстановку дня карточки
 * места (tests/unit/tools-safety-result.test.tsx).
 *
 * Судится рендером карточки.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, error: null, localOnly: false, toggle: async () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));
vi.mock('@/components/routes/useAnchor', () => ({
  useAnchor: () => ({ anchor: { lat: 53.0195, lng: 158.6505 }, label: 'от Петропавловска', requestGeo: () => {} }),
}));

import PlaceCard from '@/components/routes/PlaceCard';
import type { RouteItem } from '@/components/routes/RouteCard';

beforeAll(() => {
  class IO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
  // Погода зон не нужна этой проверке: пустой ответ.
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ zones: [] }), { status: 200 })) as typeof fetch;
});
afterEach(cleanup);

const place = (isOpen: boolean | null): RouteItem => ({
  id: '4dd86a74-d010-4ff4-81ad-23af3ba966a5', kind: 'place', category: 'eco', locationType: 'island',
  title: 'Остров Старичков', description: '', lat: 52.77, lng: 158.6, priceFrom: null, difficulty: null,
  durationDays: null, isOpen,
});

describe('карточка места в каталоге', () => {
  it('TRUE по умолчанию — никакого «открыто»', () => {
    render(<PlaceCard route={place(true)} />);
    expect(screen.getByText('Остров Старичков')).toBeTruthy();
    expect(screen.queryByText(/открыто/i)).toBeNull();
  });

  it('NULL — тоже ничего', () => {
    render(<PlaceCard route={place(null)} />);
    expect(screen.queryByText(/открыто|закрыто/i)).toBeNull();
  });

  it('закрыл администратор — «закрыто» видно', () => {
    render(<PlaceCard route={place(false)} />);
    expect(screen.getByText(/закрыто/i)).toBeTruthy();
  });
});

describe('погода на плитке — района, и сказано, что района', () => {
  it('подпись называет район прогноза, а не место', async () => {
    vi.resetModules();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      zones: [{ key: 'avachinsky', tempC: 3, windKmh: 12, gustKmh: null, descRu: 'облачно' }],
    }), { status: 200 })) as typeof fetch;
    const { default: FreshPlaceCard } = await import('@/components/routes/PlaceCard');
    const { findByTitle } = render(<FreshPlaceCard route={{ ...place(null), lat: 53.26, lng: 158.83 }} />);
    const chip = await findByTitle(/Прогноз для района «Авачинский вулкан», а не у самого места/);
    expect(chip.textContent).toContain('+3°');
  });
});
