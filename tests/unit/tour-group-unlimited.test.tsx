/**
 * «Группа не ограничена» на карточке тура (слово владельца 29.10: «да,
 * сделай «группа не ограничена» на карточке»).
 *
 * У Курильского озера гида Запорожца карточка писала «Группа: до 12», хотя
 * гид сказал «количество человек не ограничено … можно нанять еще машины»:
 * 12 — потолок одной заявки в форме, а не предел тура. Признак
 * operator_tours.group_size_unlimited (1341) меняет слова, не ёмкость.
 * Сторож судит рендером: что видит турист в полосе фактов, в строке группы и
 * под счётчиком участников формы — при TRUE и при FALSE.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/77',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import BookingFormClient from '@/components/marketplace/BookingFormClient';
import { groupZh, zhFactDescription } from '@/lib/zh/entry';

const TOUR = {
  id: 77, title: 'Курильское озеро на внедорожнике, 3 дня', description: 'Медведи и нерка.', short_description: null,
  base_price: '95000', price_old: null, price_unit: 'person', activity_type: 'jeep', location_type: 'lake',
  location_name: 'Курильское озеро', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 12,
  min_participants: 1, duration_hours: '72', duration_type: 'multi_day', multi_day_count: 3, difficulty: 'easy',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Андрей Запорожец',
  operator_id: 'p-77', operator_contacts: null,
};

/** Значение полосы фактов под меткой «Группа» — так, как его видит человек. */
function stripGroupValue(container: HTMLElement): string | null {
  const label = within(container).getAllByText('Группа').find((el) => el.nextElementSibling);
  return label?.nextElementSibling?.textContent ?? null;
}

describe('карточка тура: группа', () => {
  it('TRUE — «не ограничена» в полосе и в строке группы, «до 12» не звучит', () => {
    const { container } = render(<TourDetailClient tour={{ ...TOUR, group_size_unlimited: true }} reviews={[]} />);
    expect(stripGroupValue(container)).toBe('не ограничена');
    expect(container.textContent).toContain('Группа не ограничена (одна заявка на сайте — до 12 человек)');
    expect(container.textContent).not.toContain('Группа: 1–12 чел.');
    expect(container.textContent).not.toMatch(/Группа\s*до 12/);
    // Форма брони на той же карточке говорит, как привести группу больше.
    expect(container.textContent).toContain('Больше 12 человек — напишите в пожеланиях, оператор соберёт группу.');
  });

  it('FALSE — прежние «до N» и «1–N чел.», подсказки о большой группе нет', () => {
    const { container } = render(<TourDetailClient tour={{ ...TOUR, group_size_unlimited: false }} reviews={[]} />);
    expect(stripGroupValue(container)).toBe('до 12');
    expect(container.textContent).toContain('Группа: 1–12 чел.');
    expect(container.textContent).not.toContain('не ограничена');
    expect(container.textContent).not.toContain('напишите в пожеланиях');
  });

  it('поля нет (старая схема, запасной SELECT) — как FALSE', () => {
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(stripGroupValue(container)).toBe('до 12');
    expect(container.textContent).not.toContain('не ограничена');
  });
});

describe('форма брони: потолок заявки прежний, подсказка только при TRUE', () => {
  it('TRUE: в счётчике по-прежнему не больше 12, под ним — как заявить группу больше', () => {
    render(<BookingFormClient tourId={77} basePrice={95000} maxParticipants={20} groupSizeUnlimited tourTitle="Курильское" />);
    const select = screen.getByLabelText(/Количество участников/) as HTMLSelectElement;
    expect(select.options).toHaveLength(12);
    expect(screen.getByText('Группа не ограничена. Больше 12 человек — напишите в пожеланиях, оператор соберёт группу.')).toBeInTheDocument();
  });

  it('TRUE с числом тура меньше потолка формы — называется число тура', () => {
    render(<BookingFormClient tourId={78} basePrice={14000} maxParticipants={10} groupSizeUnlimited tourTitle="Бухта Русская" />);
    expect((screen.getByLabelText(/Количество участников/) as HTMLSelectElement).options).toHaveLength(10);
    expect(screen.getByText(/Больше 10 человек — напишите в пожеланиях/)).toBeInTheDocument();
  });

  it('FALSE: подсказки нет', () => {
    render(<BookingFormClient tourId={79} basePrice={14000} maxParticipants={12} tourTitle="Горелый" />);
    expect(screen.queryByText(/напишите в пожеланиях/)).toBeNull();
  });
});

describe('/zh: переводной конспект называет группу тем же правилом', () => {
  it('TRUE — «人数不限» и потолок одной заявки; FALSE — «最多 N 人»', () => {
    expect(groupZh(12, true)).toBe('人数不限（网站单次申请最多 12 人）');
    expect(groupZh(12, false)).toBe('最多 12 人');
    expect(groupZh(12)).toBe('最多 12 人');
    expect(zhFactDescription({ base_price: null, price_unit: null, duration_hours: null, max_participants: 10, group_size_unlimited: true }))
      .toContain('人数不限（网站单次申请最多 10 人）');
    expect(zhFactDescription({ base_price: null, price_unit: null, duration_hours: null, max_participants: 10 }))
      .toContain('最多 10 人');
  });
});
