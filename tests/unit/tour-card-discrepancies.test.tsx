/**
 * Расхождения карточки тура из сверки 20.11 (#3487), которые чинятся кодом, а
 * не словами оператора. Сторож судит рендером и вызовом: что видит человек.
 *
 *  - форма заявки резала группу до 12, хотя тур принимает 14 («Летняя рыбалка
 *    на кижуча»: в шапке «до 14», заявку на 13 и 14 человек не отправить);
 *  - шапка писала «до 14», а условия того же тура — «5–14 чел.»;
 *  - «озеро Микижа» в программе новогоднего тура давало календарь клёва и
 *    строку «в описании тура названы микижа»;
 *  - пустой блок «О туре» — один заголовок без слов;
 *  - подпись под галереей называла автора дважды: «Фото: X, X. Место».
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, within, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/6',
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
import { detectFishSpecies } from '@/lib/fish-species';
import { tourPhotoCreditLine } from '@/lib/tours/photo-credits';

const TOUR = {
  id: 6, title: 'Летняя рыбалка', description: 'Ловим на базе.', short_description: null,
  base_price: '28000', price_old: null, price_unit: 'person', activity_type: 'fishing', location_type: 'river',
  location_name: 'Река', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 14,
  min_participants: 5, duration_hours: '10', duration_type: 'single_day', multi_day_count: null, difficulty: 'easy',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Тестовая компания',
  operator_id: 'p-6', operator_contacts: null,
};

function stripGroupValue(container: HTMLElement): string | null {
  const label = within(container).getAllByText('Группа').find((el) => el.nextElementSibling);
  return label?.nextElementSibling?.textContent ?? null;
}

/** Числа в выпадающем списке «Количество участников». */
function participantOptions(container: HTMLElement): number[] {
  const select = container.querySelector('#booking-participants') as HTMLSelectElement | null;
  return select ? Array.from(select.options).map((o) => Number(o.value)) : [];
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('форма заявки принимает группу, которую обещает карточка', () => {
  it('тур с пределом 14: в форме 1–14, подсказки «напишите в пожеланиях» нет', () => {
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(participantOptions(container)).toEqual(range(14));
    expect(container.textContent).not.toContain('напишите в пожеланиях');
    cleanup();
  });

  it('тур без предела группы: одна заявка — до 12, остальное — в пожеланиях', () => {
    const { container } = render(<TourDetailClient tour={{ ...TOUR, max_participants: 30, group_size_unlimited: true }} reviews={[]} />);
    expect(participantOptions(container)).toEqual(range(12));
    expect(container.textContent).toContain('Больше 12 человек — напишите в пожеланиях');
    cleanup();
  });

  it('предел больше, чем принимает дверь заявки, — форма не обещает больше 100', () => {
    const { container } = render(<BookingFormClient tourId={6} basePrice={1000} maxParticipants={150} tourTitle="Тур" />);
    expect(participantOptions(container)).toEqual(range(100));
    cleanup();
  });
});

describe('размер группы — одна подпись в шапке и в условиях', () => {
  it('минимум 5, предел 14: «5–14» и там, и там', () => {
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(stripGroupValue(container)).toBe('5–14');
    expect(container.textContent).toContain('Группа: 5–14 чел.');
    cleanup();
  });

  it('минимум в одного — не минимум: «до 14» и там, и там', () => {
    const { container } = render(<TourDetailClient tour={{ ...TOUR, min_participants: 1 }} reviews={[]} />);
    expect(stripGroupValue(container)).toBe('до 14');
    expect(container.textContent).toContain('Группа: до 14 чел.');
    expect(container.textContent).not.toContain('1–14');
    cleanup();
  });
});

describe('имя места — не рыба', () => {
  it('«озеро Микижа» в программе не даёт календаря клёва', () => {
    const program = [{ title: 'День 1', text: 'Прогулка к озеру. Озеро Микижа — смотровая площадка, ужин в отеле.' }];
    const { container } = render(<TourDetailClient tour={{ ...TOUR, title: 'Новый год', description: 'Праздник у вулканов.', program }} reviews={[]} />);
    expect(container.textContent).not.toContain('Когда какая рыба клюёт?');
    cleanup();
  });

  it('рыба словом — рыба: «ловим микижу на озере» даёт микижу', () => {
    expect(detectFishSpecies('ловим микижу на озере').map((s) => s.id)).toContain('mikizha');
    expect(detectFishSpecies('ночёвка у озера Микижа').map((s) => s.id)).not.toContain('mikizha');
    expect(detectFishSpecies('сплав по р. Кижуч').map((s) => s.id)).not.toContain('kizhuch');
  });
});

describe('«О туре» без описания говорит словами', () => {
  it('есть краткое описание — отсылает к началу страницы', () => {
    const { getByTestId } = render(<TourDetailClient tour={{ ...TOUR, description: '', short_description: 'Рыбалка на базе за день.' }} reviews={[]} />);
    expect(getByTestId('tour-no-description').textContent).toBe('Подробного описания оператор не дал — коротко о туре сказано в начале страницы.');
    cleanup();
  });

  it('нет ни того, ни другого — так и сказано', () => {
    const { getByTestId } = render(<TourDetailClient tour={{ ...TOUR, description: null, short_description: null }} reviews={[]} />);
    expect(getByTestId('tour-no-description').textContent).toBe('Описания тура оператор не дал — подробности уточняйте у него.');
    cleanup();
  });

  it('описание есть — строки «не дал» нет', () => {
    const { container, queryByTestId } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(queryByTestId('tour-no-description')).toBeNull();
    expect(container.textContent).toContain('Ловим на базе.');
    cleanup();
  });
});

describe('автор снимков — один раз', () => {
  it('«Автор» и «Автор. Место» — один автор, в любом порядке', () => {
    expect(tourPhotoCreditLine(['Фото: Первый', 'Фото: Первый. Перевал', 'Фото: Второй'])).toBe('Фото: Первый, Второй');
    expect(tourPhotoCreditLine(['Фото: Первый. Перевал', 'Фото: Первый', null])).toBe('Фото: Первый');
    expect(tourPhotoCreditLine(['Фото: А. Б. Петров', 'Фото: Второй'])).toBe('Фото: А. Б. Петров, Второй');
  });
});
