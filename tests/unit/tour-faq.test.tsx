/**
 * Вопросы и ответы на карточке тура (слово владельца 17.11 «2 да но аккуратно»).
 *
 * «Аккуратно» держится тремя правилами (lib/tours/tour-faq):
 *  - ответ собирает та же функция, что раздел карточки, MCP и /api/tours:
 *    блок не может разойтись с разделом выше;
 *  - без ответа нет и вопроса;
 *  - группа называется только у тура «группа не ограничена» — как у агентов
 *    (число max_participants у части туров — заглушка).
 * Разметка FAQPage — из того же массива, что видимый блок.
 *
 * Здесь — вызовом правила и рендером самой карточки.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/62',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/BookingFormClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import { tourFaq, tourPaymentLine, type TourFaqInput } from '@/lib/tours/tour-faq';
import { priceWithUnitWords } from '@/lib/tours/price-label';
import { cardDuration } from '@/lib/tours/card-facts';
import { tourSeasonWords } from '@/lib/tours/season-words';
import { unlimitedGroupSentence } from '@/lib/tours/group-size';
import { pickupForCard } from '@/lib/tours/pickup';
import { platformAcceptsPayments } from '@/lib/payments/accepting';

afterEach(() => cleanup());

const FULL: TourFaqInput = {
  title: 'Вулкан Горелый',
  base_price: '15000', price_unit: 'per_person',
  duration_type: 'day', duration_hours: '10', multi_day_count: null,
  season_start: '2026-06-15', season_end: '2026-09-30',
  max_participants: 30, group_size_unlimited: true,
  pickup_type: 'hotel_pickup', pickup_details: 'Из гостиниц Петропавловска', meeting_point: null,
  cancellation_policy: 'Бесплатная отмена за 3 дня до тура\nПозже удерживается 50%',
  operator_name: 'Край Вулканов',
};
const EMPTY: TourFaqInput = {
  title: 'Тур без записей', base_price: null, price_unit: null, duration_type: null, duration_hours: null,
  multi_day_count: null, season_start: null, season_end: null, max_participants: null, group_size_unlimited: null,
  pickup_type: null, pickup_details: null, meeting_point: null, cancellation_policy: null, safety_notes: null,
  operator_name: '',
};

const byQ = (items: ReturnType<typeof tourFaq>) => Object.fromEntries(items.map((i) => [i.question, i.answer]));

describe('правило: ответ — словами разделов карточки', () => {
  it('цена, длительность, сезон, группа, подвоз, отмена, кто проводит — из общих функций', () => {
    const qa = byQ(tourFaq(FULL, { acceptsPayments: false }));
    expect(qa['Сколько стоит тур «Вулкан Горелый»?']).toBe(`${priceWithUnitWords('15000', 'per_person')}.`);
    expect(qa['Сколько длится тур «Вулкан Горелый»?']).toBe(`${cardDuration(FULL)}.`);
    expect(qa['Когда проходит тур «Вулкан Горелый»?']).toBe(`Сезон: ${tourSeasonWords(FULL)}.`);
    expect(qa['Сколько человек в группе тура «Вулкан Горелый»?']).toBe(unlimitedGroupSentence(30));
    const pickup = pickupForCard('hotel_pickup', 'Из гостиниц Петропавловска')!;
    expect(qa['Как попасть на тур «Вулкан Горелый»?']).toBe(`${pickup.title}. ${pickup.summary} Из гостиниц Петропавловска.`);
    expect(qa['Можно ли отменить тур «Вулкан Горелый»?'])
      .toBe('Бесплатная отмена за 3 дня до тура. Позже удерживается 50%. Условия оператора.');
    expect(qa['Кто проводит тур «Вулкан Горелый»?']).toBe('Тур проводит «Край Вулканов».');
  });

  it('оплата — та же строка, что под ценой, по выключателю оплаты', () => {
    expect(byQ(tourFaq(FULL, { acceptsPayments: false }))['Как записаться на тур «Вулкан Горелый» и как его оплатить?'])
      .toBe(tourPaymentLine(false));
    expect(byQ(tourFaq(FULL, { acceptsPayments: true }))['Как записаться на тур «Вулкан Горелый» и как его оплатить?'])
      .toBe(tourPaymentLine(true));
    expect(tourPaymentLine(false)).toContain('Ведар платежи не принимает');
  });

  it('отмена из правил безопасности — с подписью, откуда слова', () => {
    const qa = byQ(tourFaq({ ...EMPTY, title: 'Узон', safety_notes: ['При отмене из-за погоды деньги возвращаются в полном объёме'] }, { acceptsPayments: false }));
    expect(qa['Можно ли отменить тур «Узон»?']).toMatch(/^Об отмене оператор пишет в правилах безопасности тура: При отмене из-за погоды деньги возвращаются в полном объёме\. Других сроков/);
  });

  it('сезон не записан, но есть даты в календаре — сказано так', () => {
    const qa = byQ(tourFaq({ ...EMPTY, title: 'Т' }, { acceptsPayments: false, calendar: { first: '2026-12-01', last: '2027-03-31' } }));
    expect(qa['Когда проходит тур «Т»?']).toMatch(/^Сезон не записан; даты в календаре оператора: /);
  });
});

describe('правило: без ответа нет и вопроса', () => {
  it('ничего не записано — остаётся только оплата, которую знает платформа', () => {
    const items = tourFaq(EMPTY, { acceptsPayments: false });
    expect(items.map((i) => i.question)).toEqual(['Как записаться на тур «Тур без записей» и как его оплатить?']);
  });

  it('число группы без признака «не ограничена» — не ответ (как у агентов)', () => {
    const qa = byQ(tourFaq({ ...FULL, group_size_unlimited: false, max_participants: 15 }, { acceptsPayments: false }));
    expect(Object.keys(qa).some((q) => q.startsWith('Сколько человек'))).toBe(false);
  });

  it('единица цены не записана — так и сказано, а не «за человека»', () => {
    const qa = byQ(tourFaq({ ...FULL, price_unit: null }, { acceptsPayments: false }));
    expect(qa['Сколько стоит тур «Вулкан Горелый»?']).toMatch(/за что назначена цена, не записано/);
  });
});

describe('карточка тура: блок и разметка из одного массива', () => {
  const TOUR = {
    id: 62, title: 'Вулкан Горелый', description: 'Подъём к кратеру.', short_description: null,
    base_price: '15000', price_old: null, price_unit: 'per_person', activity_type: 'trekking', location_type: 'volcano',
    location_name: 'Горелый', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
    pickup_details: null, cancellation_policy: 'Бесплатная отмена за 3 дня до тура', tour_image: null, photos: [],
    max_participants: 15, min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null,
    difficulty: 'medium', included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
    seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Край Вулканов',
    operator_id: 'p-1', operator_contacts: null,
  };

  it('видимые вопросы и FAQPage совпадают; группы-заглушки нет', () => {
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    const section = screen.getByTestId('faq-section');
    expect(within(section).getByRole('heading', { name: 'Вопросы и ответы' })).toBeTruthy();
    const visible = [...section.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    const expected = tourFaq(TOUR, { acceptsPayments: platformAcceptsPayments() }).map((i) => [i.question, i.answer]);
    expect(visible).toEqual(expected);
    expect(visible.map(([q]) => q)).toContain('Сколько стоит тур «Вулкан Горелый»?');
    expect(visible.some(([q]) => String(q).startsWith('Сколько человек'))).toBe(false);

    const ld = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent ?? '{}') as { '@type'?: string; mainEntity?: Array<{ name: string; acceptedAnswer: { text: string } }> })
      .find((j) => j['@type'] === 'FAQPage');
    expect(ld, 'разметки FAQPage нет').toBeDefined();
    expect(ld!.mainEntity!.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(visible);
  });

  it('строка под ценой — та же, что ответ об оплате', () => {
    render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(screen.getAllByText(tourPaymentLine(platformAcceptsPayments())).length).toBeGreaterThanOrEqual(2);
  });
});
