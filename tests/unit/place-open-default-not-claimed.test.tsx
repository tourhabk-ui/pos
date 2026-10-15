/**
 * Значение по умолчанию не выдаётся за живой статус, незнание — за низкий
 * риск (15.10, §0 «честность»).
 *
 * `location_real_time_status.is_open` проставлен TRUE всем местам при
 * заведении (070/0645): TRUE значит «никто не закрыл», а не «проверили —
 * открыто». Карточка каталога рисовала по нему зелёное мигающее «открыто» на
 * каждом месте. «Анализатор безопасности» начинал оценку с единицы, и место,
 * о котором платформа не знает ничего, получало «1/5 · Низкий риск».
 *
 * Судится рендером карточки и вызовом оценки.
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
import { placeRiskScore } from '@/lib/safety/place-risk-score';

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

describe('оценка риска места (/tools/safety)', () => {
  it('ничего не записано и предупреждений нет — «не оценён», а не «низкий»', () => {
    expect(placeRiskScore([], null, null)).toBeNull();
    expect(placeRiskScore([], 0, null)).toBeNull();
  });

  it('записанная опасность не даёт «низкий риск» — термальное поле тоже', () => {
    expect(placeRiskScore(['thermal'], null, null)).toBe(2);
  });

  it('газ, лавины, сложность 4–5 — не ниже 3', () => {
    expect(placeRiskScore(['volcanic_gas'], null, null)).toBe(3);
    expect(placeRiskScore([], null, 4)).toBe(3);
  });

  it('уровень предупреждения — шкалой 0–3: критичное (2) не ниже 3, чрезвычайное (3) — 4', () => {
    expect(placeRiskScore([], 2, null)).toBe(3);
    expect(placeRiskScore([], 3, null)).toBe(4);
  });

  it('известная лёгкая сложность без опасностей — единица остаётся', () => {
    expect(placeRiskScore([], null, 2)).toBe(1);
  });
});
