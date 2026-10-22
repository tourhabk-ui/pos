/**
 * Список туров кабинета говорит, видит ли тур турист (#2642).
 *
 * Новый тур заводится с `is_published = false` (миграция 040, `createTour`),
 * и каталог Ведара его не показывает — отбор идёт шлюзом `publicTourSql`. А
 * список туров ставил бейдж по одному `is_active`: черновик выглядел
 * «Активен», и оператор ждал броней от тура, которого туристы не видят.
 *
 * Сторож — рендер списка с данными API: бейдж считает `storefrontState`
 * рядом со шлюзом, по флагам и с ответом шлюза из того же запроса
 * (`on_storefront`). Что `on_storefront` совпадает с выдачей каталога на
 * настоящей базе, держит `tests/integration/public-tour-gate.pg.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, act, within } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/hub/operator/tours',
  useParams: () => ({}),
}));

import ToursManagementClient from '@/app/hub/operator/tours/_ToursManagementClient';
import { STOREFRONT_LABELS } from '@/lib/tours/public-visibility';

type Flags = { is_active: boolean; is_published: boolean; on_storefront: boolean };

const tour = (id: string, title: string, flags: Flags) => ({
  id, title, ...flags,
  activity_type: 'trekking', location_name: 'Авачинский перевал', base_price: '5000',
  max_participants: 10, duration_hours: 8, difficulty: 'medium',
  tour_image: null, photos: null, rating: null, review_count: 0,
  total_bookings: '0', total_revenue: '0', created_at: '2026-10-20T00:00:00Z',
  available_slots: null, next_available_date: null,
});

const TOURS = [
  // Тур, как его заводит createTour: включён, но не опубликован.
  tour('1', 'Новый тур на Авачинский', { is_active: true, is_published: false, on_storefront: false }),
  tour('2', 'Вулкан Горелый', { is_active: true, is_published: true, on_storefront: true }),
  tour('3', 'Сплав по Быстрой', { is_active: false, is_published: true, on_storefront: false }),
];

async function renderList() {
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
    success: true, data: TOURS, pagination: { total: TOURS.length },
  }), { status: 200 }))) as unknown as typeof fetch;
  render(<ToursManagementClient />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(cleanup);

describe('список туров кабинета: бейдж по витрине каталога, а не по is_active', () => {
  it('черновик (is_active = true, is_published = false) — «Черновик — туристы не видят», не «Активен»', async () => {
    await renderList();
    const card = screen.getByRole('article', { name: 'Новый тур на Авачинский' });
    const badge = within(card).getByText('Черновик — туристы не видят');
    expect(badge).toHaveClass('ds-badge');
    expect(card).not.toHaveTextContent('Активен');
    expect(card).not.toHaveTextContent(STOREFRONT_LABELS.on);
  });

  it('тур на витрине — «На витрине», выключенный — «Скрыт»', async () => {
    await renderList();
    expect(within(screen.getByRole('article', { name: 'Вулкан Горелый' })).getByText('На витрине')).toHaveClass('ds-badge');
    expect(within(screen.getByRole('article', { name: 'Сплав по Быстрой' })).getByText('Скрыт')).toHaveClass('ds-badge');
    // Слова «Активен» в списке нет вовсе: оно и было той ложью.
    expect(screen.queryByText('Активен')).toBeNull();
  });

  it('у каждого тура ровно одна подпись состояния', async () => {
    await renderList();
    const labels = Object.values(STOREFRONT_LABELS);
    for (const t of TOURS) {
      const card = screen.getByRole('article', { name: t.title });
      const shown = labels.filter((l) => within(card).queryByText(l) !== null);
      expect(shown, t.title).toHaveLength(1);
    }
  });
});
