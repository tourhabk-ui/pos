/**
 * Путь агента-браузера от ссылки до заявки — целиком (#2968, 03.11).
 *
 * До этого дня путь был покрыт кусками: разбор `?date=&guests=` вызовом,
 * HTML формы и `ReserveAction` — регуляркой по исходнику. Никто не проверял,
 * что агент, открывший `/catalog/tours/<slug>?date=…&guests=…#booking`,
 * получает заполненную форму, а отправка доходит до настоящего роута и
 * человек слышит честный исход.
 *
 * Здесь без браузера, но с настоящими частями пути:
 *   1. страница-двойник `/catalog/tours/[id]/request` рендерится в HTML на
 *      сервере (renderToString — то, что видит агент без JavaScript): форма
 *      с подписанными полями, дата и число людей подставлены, капчи нет,
 *      JSON-LD с `ReserveAction` на этот адрес и ценой из базы, «заявка — не
 *      бронь», обещания мгновенной брони нет;
 *   2. та же карточка в jsdom: поля заполняются по подписям, отправка формы
 *      идёт в НАСТОЯЩИЙ `POST /api/hub/bookings/create` (подменены только
 *      база и рассылки), ответ возвращается в форму;
 *   3. исходы: заявка создана — переход на страницу заявки и `created: true`;
 *      дата прошла и мест нет — «Заявка не создана: …», `created: false`,
 *      HTTP не 200.
 * Прод этим не трогается: заявка на проде легла бы в CRM как настоящая.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/agent-test-tur',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('notFound'); },
  permanentRedirect: () => { throw new Error('redirect'); },
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));

const DATE = '2099-07-15';
const TOUR = {
  id: 62, slug: 'agent-test-tur', title: 'Авачинский перевал', description: 'Джип-сафари к подножию вулканов.', short_description: null,
  base_price: '11000', price_old: null, price_unit: 'person', activity_type: 'jeep', location_type: 'volcano',
  location_name: 'Авачинский перевал', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 15,
  min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null, difficulty: 'medium',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Оператор',
  operator_id: 'p-1', operator_contacts: null, main_place_id: null,
};

vi.mock('@/lib/tours/tour-detail-query', () => ({
  loadTourCard: async (id: string) => (id === 'agent-test-tur' || id === '62' ? { tour: TOUR, byId: false } : null),
  getTourReviews: async () => [],
}));
vi.mock('@/lib/tours/open-dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tours/open-dates')>()),
  countTourDates: async () => null,
}));
vi.mock('@/lib/partners/reach', () => ({ reachForTour: async () => null }));
vi.mock('@/lib/places/place-tours', () => ({ loadPlaceOffersForTour: async () => ({ state: 'none' }) }));
vi.mock('@/lib/zh/content', () => ({ zhTourAlternatePath: async () => null }));

// Роут заявки — настоящий; подменены только запись в базу и рассылки.
const reserveMock = vi.fn();
vi.mock('@/lib/bookings/reserve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookings/reserve')>()),
  reserveBooking: (...a: unknown[]) => reserveMock(...a),
}));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getTrustedClientIp: () => '10.0.0.1',
  getClientIp: () => '10.0.0.1',
}));
vi.mock('@/lib/bookings/notify-operator', () => ({ notifyOperatorOfNewBooking: vi.fn(async () => undefined) }));
vi.mock('@/lib/notifications/tourist-mail', () => ({ sendTouristMail: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: vi.fn(async () => null) }));
vi.mock('@/lib/bookings/auto-confirm', () => ({ autoConfirmIfAllowed: vi.fn(async () => 'new') }));
vi.mock('@/lib/funnel/record', () => ({ recordFunnelEvent: vi.fn(async () => undefined), visitorFromHeaders: () => 'v' }));
vi.mock('@/lib/telegram/booking-notify', () => ({ notifyTouristBookingCreated: vi.fn() }));

import TourRequestPage from '@/app/catalog/tours/[id]/request/page';
import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import { POST as createBooking } from '@/app/api/hub/bookings/create/route';
import { ReserveError } from '@/lib/bookings/reserve';
import { checkAgentTourHtml } from '@/scripts/agent-path/check-tour-page.mjs';

const createCalls: unknown[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('/api/hub/bookings/create')) {
    createCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return createBooking(new Request(`http://localhost${u}`, init) as never);
  }
  if (u.includes('/slots')) return new Response(JSON.stringify({ success: true, slots: [{ date: DATE, free_slots: 6 }] }), { status: 200 });
  return new Response('{}', { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  createCalls.length = 0;
  pushMock.mockReset();
  reserveMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function serverHtml(query: Record<string, string>): Promise<Document> {
  const el = await TourRequestPage({ params: Promise.resolve({ id: 'agent-test-tur' }), searchParams: Promise.resolve(query) });
  return new DOMParser().parseFromString(renderToString(el as React.ReactElement), 'text/html');
}

describe('1. серверный HTML по ссылке агента — без JavaScript', () => {
  it('форма заявки видна, поля подписаны, дата и люди подставлены, капчи нет', async () => {
    const doc = await serverHtml({ date: DATE, guests: '3' });
    const booking = doc.getElementById('booking');
    expect(booking).not.toBeNull();
    expect(booking!.getAttribute('data-tour-slug')).toBe('agent-test-tur');
    expect(booking!.textContent).toContain('Заявка — не бронь');
    // Каждое поле, которое заполняет агент, подписано label[for].
    for (const id of ['booking-participants', 'booking-name', 'booking-phone', 'booking-email']) {
      expect(doc.querySelector(`label[for="${id}"]`), id).not.toBeNull();
      expect(doc.getElementById(id), id).not.toBeNull();
    }
    expect((doc.getElementById('booking-date-value') as HTMLInputElement).value).toBe(DATE);
    expect(booking!.textContent).toContain(`Выбрана дата: ${DATE}`);
    const people = doc.getElementById('booking-participants') as HTMLSelectElement;
    expect(people.querySelector('option[selected]')?.getAttribute('value')).toBe('3');
    expect(doc.body.innerHTML).not.toMatch(/captcha|recaptcha|hcaptcha|turnstile/i);
  });

  it('JSON-LD: ReserveAction на этот адрес и цена из базы; мгновенной брони не обещаем', async () => {
    const doc = await serverHtml({ date: DATE, guests: '2' });
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? '{}') as Record<string, unknown>);
    const tour = ld.find((x) => x.potentialAction);
    expect(tour).toBeDefined();
    const action = tour!.potentialAction as { '@type': string; target: { urlTemplate: string } };
    expect(action['@type']).toBe('ReserveAction');
    expect(action.target.urlTemplate).toBe('https://vedarai.ru/catalog/tours/agent-test-tur?date={date}&guests={guests}#booking');
    // Цена предложения — та, что в базе (base_price), в любом узле графа.
    const prices: number[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o['@type'] === 'Offer' && o.price !== undefined) prices.push(Number(o.price));
        Object.values(o).forEach(walk);
      }
    };
    walk(ld);
    expect(prices.length).toBeGreaterThan(0);
    expect(new Set(prices)).toEqual(new Set([11000]));
    expect(doc.body.textContent ?? '').not.toMatch(/мгновенн\S* (бронь|бронирование|подтвержд)(?! нет)|бронь подтверждена сразу/i);
  });

  it('проба прода (scripts/agent-path) судит тем же правилом: на настоящем HTML всё на месте', async () => {
    const el = await TourRequestPage({ params: Promise.resolve({ id: 'agent-test-tur' }), searchParams: Promise.resolve({ date: DATE, guests: '3' }) });
    const html = renderToString(el as React.ReactElement);
    const checks = checkAgentTourHtml(html, { slug: 'agent-test-tur', date: DATE, guests: 3 });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(10);
    // Без даты в адресе проба говорит «дата не подставлена», а не «хорошо».
    const empty = renderToString(await TourRequestPage({ params: Promise.resolve({ id: 'agent-test-tur' }), searchParams: Promise.resolve({}) }) as React.ReactElement);
    expect(checkAgentTourHtml(empty, { slug: 'agent-test-tur', date: DATE, guests: 3 }).filter((c) => !c.ok).map((c) => c.check))
      .toEqual(expect.arrayContaining(['дата подставлена', 'число людей подставлено']));
  });

  it('без параметров форма пустая: дата не выдумана', async () => {
    const doc = await serverHtml({});
    expect((doc.getElementById('booking-date-value') as HTMLInputElement).value).toBe('');
  });
});

async function fillAndSend(): Promise<void> {
  render(<TourDetailClient tour={TOUR as never} reviews={[]} prefill={{ date: DATE, guests: 2 }} />);
  fireEvent.change(screen.getByLabelText('Имя *'), { target: { value: 'Иван Проверка' } });
  fireEvent.change(screen.getByLabelText('Телефон *'), { target: { value: '+7 900 123 45 67' } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ivan@example.com' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
  fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));
}

describe('2–3. отправка формы доходит до настоящего роута, исход честный', () => {
  it('заявка создана: роут ответил created: true, форма ведёт на страницу заявки', async () => {
    reserveMock.mockResolvedValue({ bookingId: 501, accessToken: 'tok-1', totalPrice: 22000, tourTitle: TOUR.title, operatorId: 'p-1' });
    await fillAndSend();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/booking-success/501?t=tok-1'));
    expect(createCalls[0]).toMatchObject({ tour_id: 62, booking_date: DATE, participants_count: 2, pd_consent: true });
    expect(reserveMock.mock.calls[0]![0]).toMatchObject({ tourId: 62, date: DATE, participants: 2 });
  });

  it('мест нет: «Заявка не создана: …» в форме, перехода нет', async () => {
    reserveMock.mockRejectedValue(new ReserveError('NO_SLOTS', 'На эту дату свободно только 1 место.'));
    await fillAndSend();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Заявка не создана: На эту дату свободно только 1 место.');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('роут для агента без браузера: created и HTTP-статус называют исход', async () => {
    reserveMock.mockResolvedValue({ bookingId: 7, accessToken: 't', totalPrice: 11000, tourTitle: TOUR.title, operatorId: 'p-1' });
    const post = (body: Record<string, unknown>) => createBooking(new Request('http://localhost/api/hub/bookings/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as never);
    const base = { tour_slug: 'agent-test-tur', booking_date: DATE, participants_count: 2, tourist_name: 'Иван', tourist_phone: '+79001234567', tourist_email: 'i@example.com', pd_consent: true };

    const ok = await post(base);
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as Record<string, unknown>;
    expect(okBody).toMatchObject({ created: true, booking_id: 7 });
    expect(String(okBody.message)).toMatch(/Оператор подтвердит/);

    const past = await post({ ...base, booking_date: '2020-01-01' });
    expect(past.status).toBe(422);
    expect(await past.json()).toMatchObject({ created: false });

    const noConsent = await post({ ...base, pd_consent: false });
    expect(noConsent.status).toBe(400);
    expect(await noConsent.json()).toMatchObject({ created: false, field: 'pd_consent' });

    reserveMock.mockRejectedValueOnce(new ReserveError('NO_SLOTS', 'Мест нет.'));
    const full = await post(base);
    expect(full.status).toBe(422);
    expect(await full.json()).toMatchObject({ created: false, error: 'Мест нет.' });
  });
});
