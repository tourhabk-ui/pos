/**
 * Отзыв о туре предлагается по СВОИМ поездкам, а не по витрине.
 *
 * ── Что нашлось обходом экранов туриста 26.09 ────────────────────────────
 *
 * Экран «Мои отзывы» брал список туров для формы из `/api/tours` — то есть из
 * каталога. Сервер при этом принимает отзыв только по ЗАВЕРШЁННОЙ брони этого
 * человека (`POST /api/reviews/tour/[tourId]`), и расхождение шло в обе
 * стороны:
 *
 *   • форма предлагала любой тур платформы — выбор обещал то, чего сервер не
 *     разрешит, и человек узнавал об этом после нажатия «Отправить»;
 *   • после появления шлюза публикации (`lib/tours/public-visibility.ts`) из
 *     каталога исчезают снятые с витрины туры — и отзыв о поездке, которая
 *     СОСТОЯЛАСЬ, стало бы нечем оставить. Витрина отвечает на вопрос «что
 *     можно купить», а форма отзыва — на вопрос «где я был»; это разные
 *     вопросы, и источник у них разный.
 *
 * Сторож держит именно связку «форма спрашивает о своих поездках», а не
 * конкретный адрес: витрина в этом файле не должна появиться снова.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewTourOptions } from '@/app/hub/tourist/reviews/review-options';
import { rowToBooking, type BookingRow } from '@/lib/tourist/cabinet';

const SRC = readFileSync(
  join(process.cwd(), 'app/hub/tourist/reviews/_ReviewsClient.tsx'),
  'utf-8',
);

/** Строка брони кабинета с нужным статусом — остальное не влияет на canReview. */
const row = (booking_status: string): BookingRow => ({
  id: '7', booking_date: '2026-10-10', participants: 2, final_price: '22000', booking_status,
  payment_status: null, special_requests: null, created_at: '2026-10-01', updated_at: '2026-10-11',
  tour_id: '62', tour_title: 'Авачинский перевал', tour_description: null, tour_difficulty: null,
  duration_hours: null, tour_photos: null, tour_image: null, operator_name: 'Местечко Камчатка',
  operator_contact: null,
} as BookingRow);

describe('форма отзыва спрашивает свои поездки', () => {
  it('источник вариантов — брони туриста', () => {
    expect(SRC).toMatch(/'\/api\/bookings\/my'/);
  });

  it('витрина туров источником не служит', () => {
    // `/api/tours` и `/api/tours?...` — каталог. Своих отзывов (`/api/reviews/my`)
    // это не касается.
    const usesCatalog = /useApiFetch<[^>]*>\(\s*'\/api\/tours/.test(SRC) || /'\/api\/tours'/.test(SRC);
    expect(
      usesCatalog,
      'список туров для отзыва снова берётся из витрины: снятый с продажи тур пропадёт, и отзыв о состоявшейся поездке оставить будет нечем',
    ).toBe(false);
  });

  it('в варианты попадают только поездки, где отзыв примет сервер, без повторов', () => {
    // 13.10: «не явился» показывается завершённой поездкой (status), но отзыв по
    // нему сервер отклоняет 403 — решает canReview, то же правило, что у сервера.
    expect(reviewTourOptions([
      { status: 'completed', canReview: true, tour: { id: '1', name: 'Вулкан Горелый' } },
      { status: 'completed', canReview: false, tour: { id: '2', name: 'Не явился' } },
      { status: 'confirmed', canReview: false, tour: { id: '3', name: 'Ещё не был' } },
      { status: 'completed', canReview: true, tour: { id: '1', name: 'Вулкан Горелый' } },
      { status: 'completed', canReview: true, tour: { id: '4' } },
    ])).toEqual([{ id: '1', name: 'Вулкан Горелый' }]);
    expect(reviewTourOptions(undefined)).toEqual([]);
  });

  it('canReview отдаёт кабинет по статусу брони, а не по статусу показа', () => {
    expect(rowToBooking(row('completed')).canReview).toBe(true);
    expect(rowToBooking(row('no_show'))).toMatchObject({ status: 'completed', canReview: false });
    expect(rowToBooking(row('confirmed')).canReview).toBe(false);
  });

  it('пустой список назван словами, а не пустым селектом', () => {
    expect(SRC).toMatch(/Завершённых поездок у вас пока нет/);
  });
});
