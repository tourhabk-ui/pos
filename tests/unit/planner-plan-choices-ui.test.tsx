/**
 * Сторож экрана: жильё — пункт плана (#2304, шаг 3); трансфер — машина
 * целиком под заказ, пунктом плана не бывает (владелец 13.10: «бронируют
 * целую машину а не место в ней»).
 *
 * Сквозь экраны, поведением:
 *   — в /planner жильё можно взять в план: смета тут же заменяет ориентир
 *     ночи ценой стоянки; заявка уходит с выбранным;
 *   — трансфер — перевозчики «под заказ» со ссылкой на прайс и заявку; кнопки
 *     «в план» у них нет, ориентир трансферов аэропорта в смете остаётся;
 *   — ссылка на объект открывает форму брони с датами, гостями (не больше
 *     вместимости номера) и номером, и форма говорит, сколько номеров в плане.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));
// Календарь и выбор гостей — заглушки: проверяется, ЧТО форма им передала.
const ymd = (d: Date | null | undefined) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '-');
vi.mock('@/components/booking/calendars/StayDatePicker', () => ({
  StayDatePicker: (p: { initialCheckIn?: Date | null; initialCheckOut?: Date | null }) =>
    React.createElement('div', { 'data-testid': 'dates' }, `${ymd(p.initialCheckIn)}|${ymd(p.initialCheckOut)}`),
}));
vi.mock('@/components/booking/ui/GuestSelector', () => ({
  GuestSelector: (p: { initialAdults: number; initialChildren: number; maxGuests: number }) =>
    React.createElement('div', { 'data-testid': 'guests' }, `${p.initialAdults}+${p.initialChildren}/${p.maxGuests}`),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, isLoading: false }) }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/transfers/CharterCard', () => ({ CharterCard: () => null }));
vi.mock('@/components/marketplace/SbpQrPayment', () => ({ default: () => null }));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { StayBookingForm } from '@/components/booking/StayBookingForm';

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s/g, ' ');

// ── /planner ─────────────────────────────────────────────────────────────────

const day = (n: number, type: string, zone: string, extra: Record<string, unknown> = {}) => ({
  day: n, type, zone, title: `День ${n}`, description: '', activityType: 'rest',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});
const RECOMMENDATION = {
  zones: [], warnings: [], itinerary: '',
  days: [day(1, 'arrival', 'avachinsky'), day(2, 'activity', 'western', { realTour: { lodgingIncluded: true } }), day(3, 'departure', 'avachinsky')],
  priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] },
};
const ROOM = '11111111-1111-4111-8111-111111111111';
const EXTRAS = {
  lodging: {
    state: 'checked', nightsInTours: 1, unzonedCount: 0,
    stays: [{ zone: 'avachinsky', zoneName: 'Авачинская зона', checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1,
      result: { state: 'ok', items: [{
        id: 'acc-1', name: 'Дом у вулкана', type: 'guesthouse', priceFrom: 6000, rating: null, reviewCount: 0, isVerified: true,
        stay: { kind: 'priced', total: 12000, rooms: 1, roomId: ROOM, roomName: 'Двухместный', maxGuests: 2 },
      }] } }],
  },
  transfer: {
    state: 'ok',
    items: [{ slug: 'shatun', name: 'Шатун', fleet: '2 × вахтовка, 26 мест', priceFromRub: 65000, destinations: 9 }],
  },
};

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : null });
    const json = u.startsWith('/api/planner/trip-extras') ? { success: true, data: EXTRAS }
      : u.startsWith('/api/planner/recommend') ? { success: true, data: RECOMMENDATION }
        : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));

async function planWithExtras() {
  render(<PlannerClient />);
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
  next();
  next();
  fireEvent.click(document.querySelector('[data-need="lodging"]')!);
  fireEvent.click(document.querySelector('[data-need="transfer"]')!);
  next();
  fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
  fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
  // Ответ дополнений приходит после паузы в 300 мс — ждём сами варианты.
  await screen.findByRole('button', { name: 'Взять в план: Дом у вулкана' }, { timeout: 3000 });
  return screen.getByTestId('trip-extras');
}

// Тесты проходят анкету целиком на настоящем PlannerClient: четыре шага,
// пауза дополнений в 300 мс, первый рендер холодный. Отдельно первый тест —
// 3,9 с (после карты планировщика #2689 экран тяжелее: было 2,7 с), под
// полным набором на занятой машине — 5,4 с, за 5 с по умолчанию. Проверки
// те же, запас — на время, а не на смысл.
describe('/planner: взять в план', { timeout: 15_000 }, () => {
  it('жильё в плане — ночь из ориентира уходит, стоянка встаёт своей ценой', async () => {
    const section = await planWithExtras();
    const estimate = screen.getByTestId('price-estimate');
    expect(text(estimate)).toContain('Проживание в Авачинской зоне');

    const pick = within(section).getByRole('button', { name: 'Взять в план: Дом у вулкана' });
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    expect(text(within(section).getByTestId('lodging-option'))).toContain('12 000 ₽на группу за 1 ночь');
    fireEvent.click(pick);

    expect(within(section).getByRole('button', { name: 'Убрать из плана: Дом у вулкана' }).getAttribute('aria-pressed')).toBe('true');
    const after = screen.getByTestId('price-estimate');
    expect(text(after)).toContain('Жильё «Дом у вулкана», 03.08–04.08');
    expect(text(after)).toContain('1 ночь × 1 номер «Двухместный» · выбрано');
    expect(text(after)).not.toContain('Проживание в Авачинской зоне');
    expect(text(after)).toMatch(/Выбранное жильё — по ценам на платформе \(12 000 ₽\)/);

    // Повторное нажатие — ориентир вернулся.
    fireEvent.click(within(section).getByRole('button', { name: 'Убрать из плана: Дом у вулкана' }));
    expect(text(screen.getByTestId('price-estimate'))).toContain('Проживание в Авачинской зоне');
  });

  it('трансфер — машина целиком: в план не берётся, ориентир аэропорта остаётся; заявка уходит с жильём', async () => {
    const section = await planWithExtras();
    const body = calls.find((c) => c.url === '/api/planner/trip-extras')!.body!;
    expect(body.tripOrigin).toBe('visitor');

    const transfer = within(section).getByTestId('extras-transfer');
    expect(text(transfer)).toContain('Трансфер — машина целиком');
    expect(text(transfer)).toContain('цена за машину, не за место');
    expect(within(transfer).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(within(section).getByRole('button', { name: 'Взять в план: Дом у вулкана' }));
    const estimate = text(screen.getByTestId('price-estimate'));
    expect(estimate).toContain('Трансферы аэропорта');
    expect(estimate).not.toMatch(/\d мест|за место/);

    fireEvent.click(screen.getAllByRole('button', { name: /Запросить подробное предложение/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79991234567' } });
    fireEvent.click(document.getElementById('pd-consent-planner')!);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/leads')).toBe(true));
    const plan = (calls.find((c) => c.url === '/api/leads')!.body!.source_data as { plan: Record<string, unknown> }).plan;
    expect(plan.lodging).toEqual([expect.objectContaining({ accommodation_id: 'acc-1', total: 12000, check_in: '2030-08-03' })]);
    expect(plan).not.toHaveProperty('transfers');
  });

  it('ссылки: объект — с датами стоянки, составом и номером; перевозчик — на его прайс и заявку', async () => {
    const section = await planWithExtras();
    expect(within(section).getByText('Дом у вулкана').closest('a')?.getAttribute('href'))
      .toBe(`/accommodations/acc-1?check_in=2030-08-03&check_out=2030-08-04&adults=2&children=0&room=${ROOM}`);
    expect(within(section).getByText('Шатун').closest('a')?.getAttribute('href')).toBe('/transfers/shatun');
  });
});

// ── Форма брони жилья по ссылке ──────────────────────────────────────────────

describe('форма брони жилья подставляет ссылку плана', () => {
  const R1 = '11111111-1111-4111-8111-111111111111';
  const R2 = '22222222-2222-4222-8222-222222222222';
  const rooms = [
    { id: R1, name: 'Одноместный', roomType: 'single', maxGuests: 1, pricePerNight: 3000 },
    { id: R2, name: 'Двухместный', roomType: 'double', maxGuests: 2, pricePerNight: 5000 },
  ];
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('даты, номер и гости не больше вместимости; сколько номеров в плане — сказано', async () => {
    window.history.replaceState({}, '', `/accommodations/a1?check_in=2030-08-03&check_out=2030-08-05&adults=3&children=1&room=${R2}&rooms=2`);
    render(<StayBookingForm accommodationId="a1" accommodationName="Дом" rooms={rooms} />);
    await waitFor(() => expect(screen.getByTestId('dates').textContent).toBe('2030-08-03|2030-08-05'));
    expect((screen.getByDisplayValue(R2) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('guests').textContent).toBe('2+0/2');
    expect(text(screen.getByTestId('plan-rooms'))).toContain('По плану поездки группе нужно 2 номера этого типа');
  });

  it('номер из ссылки — первый в списке: гостей урезает сама подстановка', async () => {
    // Смены номера нет, и проверка вместимости при смене номера не сработает.
    window.history.replaceState({}, '', `/accommodations/a1?check_in=2030-08-03&check_out=2030-08-05&adults=3&children=1&room=${R2}`);
    render(<StayBookingForm accommodationId="a1" accommodationName="Дом" rooms={[rooms[1]!, rooms[0]!]} />);
    await waitFor(() => expect(screen.getByTestId('dates').textContent).toBe('2030-08-03|2030-08-05'));
    expect(screen.getByTestId('guests').textContent).toBe('2+0/2');
    expect(screen.queryByTestId('plan-rooms')).toBeNull();
  });

  it('без ссылки — форма как была: дат нет, подсказки нет', () => {
    render(<StayBookingForm accommodationId="a1" accommodationName="Дом" rooms={rooms} />);
    expect(screen.getByTestId('dates').textContent).toBe('-|-');
    expect(screen.queryByTestId('plan-rooms')).toBeNull();
  });
});

