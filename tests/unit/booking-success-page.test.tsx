/**
 * Страница после заявки (`/booking-success/[id]`): не врёт в первые секунды,
 * у гостя есть рабочий следующий шаг, оплата — только после подтверждения
 * (аудит П3, #24/#27/#75/#76/#86/#87/#92/#146, 24.09).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 *  - ключ брони начинался с '' — первый прогон эффекта решал «не найдено»
 *    раньше, чем ключ успевали прочесть, и второй прогон не возвращал
 *    спиннер: сразу после настоящей заявки человек видел «Заявка создана» и
 *    под ней «Бронирование не найдено» — на медленной сети секундами;
 *  - главная кнопка «Мои бронирования» вела гостя на вход, а гостевая бронь
 *    (user_id = NULL) в списке и после входа не появляется;
 *  - `<Link><button>` — две вложенные интерактивные цели;
 *  - «оплатить по его контактам ниже» — при пустом блоке контактов;
 *  - новая заявка ('new') сразу получала «Перейти к оплате», хотя карточка
 *    тура обещает «оплата только после подтверждения» (решение владельца
 *    24.09, развилка 4: оплата с confirmed / pending_payment);
 *  - без общей шапки: ни знака, ни SOS.
 *
 * Проверяется рендером, а не поиском строк: важен порядок состояний во
 * времени, и его видно только живым компонентом.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '1' }),
  usePathname: () => '/booking-success/1',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/script', () => ({ default: () => null }));
vi.mock('@/components/marketplace/SbpQrPayment', () => ({ default: () => null }));

import BookingSuccessClient from '@/app/booking-success/[id]/_BookingSuccessClient';
import {
  awaitsOperator, canOfferPayment, hasOperatorContacts, notBookingNotice, successHeadline,
} from '@/lib/bookings/success-view';

type Booking = Record<string, unknown>;
const BASE: Booking = {
  id: 1, tour_title: 'Сплав по реке Быстрая', booking_date: '2026-09-28', participants_count: 2,
  tourist_name: 'Аудит Тест', status: 'new', payment_status: 'pending', total_price: 26000,
  operator_name: 'Оператор', operator_phone: null, operator_telegram: null,
  cp_public_id: '', sbp_available: false, has_email: true,
};

let resolveBooking: ((b: Booking) => void) | null = null;
let authed = false;

function installFetch() {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/state')) {
      return Promise.resolve(new Response(JSON.stringify({ data: { authenticated: authed } }), { status: 200 }));
    }
    return new Promise<Response>((res) => {
      resolveBooking = (b) => res(new Response(JSON.stringify({ success: true, data: b }), { status: 200 }));
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/booking-success/1?t=key-123');
  resolveBooking = null;
  authed = false;
  installFetch();
});
afterEach(() => { cleanup(); });

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function loaded(b: Booking) {
  const view = render(<BookingSuccessClient />);
  await flush();
  expect(resolveBooking, 'запрос брони не ушёл').not.toBeNull();
  await act(async () => { resolveBooking!(b); await new Promise((r) => setTimeout(r, 0)); });
  await flush();
  return view;
}
const text = () => document.body.textContent ?? '';

describe('пока бронь не прочитана — «Проверяем заявку…», а не «не найдено»', () => {
  it('до ответа API нет ни «не найдена», ни «Заявка создана»', async () => {
    render(<BookingSuccessClient />);
    await flush();
    expect(text()).toMatch(/Проверяем заявку…/);
    expect(text()).not.toMatch(/не найдена/);
    expect(text()).not.toMatch(/Заявка создана/);
    expect(text()).not.toMatch(/переходите к оплате/);
  });

  it('после ответа — «Заявка создана»', async () => {
    await loaded(BASE);
    expect(text()).toMatch(/Заявка создана/);
    expect(text()).not.toMatch(/Проверяем заявку/);
  });

  it('без ключа в ссылке — честное «не найдена»', async () => {
    window.history.replaceState({}, '', '/booking-success/1');
    render(<BookingSuccessClient />);
    await flush();
    expect(text()).toMatch(/Заявка не найдена/);
  });
});

describe('у гостя одна главная кнопка — скопировать ссылку', () => {
  it('гость: primary ровно одна, «Мои заявки» нет', async () => {
    const { container } = await loaded(BASE);
    const primary = container.querySelectorAll('.ds-btn-primary');
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toMatch(/Скопировать ссылку на заявку/);
    expect(text()).not.toMatch(/Мои заявки/);
  });

  it('вошедший: «Мои заявки» есть, но не главная', async () => {
    authed = true;
    const { container } = await loaded(BASE);
    const link = screen.getByText('Мои заявки').closest('a');
    expect(link?.getAttribute('href')).toBe('/hub/tourist/bookings');
    expect(link?.className).not.toMatch(/ds-btn-primary/);
    expect(container.querySelectorAll('.ds-btn-primary')).toHaveLength(1);
  });

  it('ни одной кнопки внутри ссылки', async () => {
    authed = true;
    const { container } = await loaded(BASE);
    expect(container.querySelectorAll('a button, button a')).toHaveLength(0);
  });

  it('«Копировать» номер — тач-цель не меньше 44px', async () => {
    await loaded(BASE);
    const btn = screen.getByText('Копировать').closest('button');
    expect(btn?.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('оплата — только после подтверждения оператором', () => {
  it('правило статусов', () => {
    expect(canOfferPayment('new')).toBe(false);
    expect(canOfferPayment('confirmed')).toBe(true);
    expect(canOfferPayment('pending_payment')).toBe(true);
    expect(canOfferPayment(null)).toBe(false);
  });

  it("'new' при настроенной карте: оплаты нет, есть шаги", async () => {
    await loaded({ ...BASE, cp_public_id: 'pk_test' });
    expect(text()).not.toMatch(/Перейти к оплате|Загрузка\.\.\./);
    expect(text()).toMatch(/Оператор подтверждает дату/);
    expect(text()).toMatch(/оплата откроется на этой странице/i);
  });

  it("'confirmed' при настроенной карте: оплата есть, главная — она", async () => {
    const { container } = await loaded({ ...BASE, status: 'confirmed', cp_public_id: 'pk_test' });
    expect(text()).toMatch(/Загрузка\.\.\.|Перейти к оплате/);
    expect(container.querySelector('.ds-btn-primary')).toBeNull();
  });
});

describe('заголовок не утверждает подтверждение там, где его нет (§4.0)', () => {
  // Страница открывается из письма и ваучера и после отмены. До доработки
  // П3 последняя ветка отвечала «Оператор подтвердил заявку — … переходите к
  // оплате» за любой статус кроме 'new': у отменённой брони — подтверждение
  // и призыв платить при отсутствующем блоке оплаты.
  it("'cancelled': «Заявка отменена», ни «подтвердил», ни «к оплате»", async () => {
    await loaded({ ...BASE, status: 'cancelled', cp_public_id: 'pk_test' });
    expect(text()).toMatch(/Заявка отменена/);
    expect(text()).not.toMatch(/подтвердил/);
    expect(text()).not.toMatch(/к оплате/);
    expect(text()).not.toMatch(/Заявка создана/);
  });

  it("'completed' и неизвестный статус — без «подтвердил» и «Заявка создана»", async () => {
    for (const status of ['completed', 'pending', 'что-то новое']) {
      const h = successHeadline({ status, alreadyPaid: false, needsPayment: canOfferPayment(status), noPayWay: false });
      expect(h.title, status).not.toMatch(/Заявка создана/);
      expect(`${h.title} ${h.subtitle ?? ''}`, status).not.toMatch(/подтвердил|к оплате/);
    }
  });

  it('«Заявка создана» — только для new / confirmed / pending_payment', () => {
    for (const status of ['new', 'confirmed', 'pending_payment']) {
      const h = successHeadline({ status, alreadyPaid: false, needsPayment: canOfferPayment(status), noPayWay: false });
      expect(h.title, status).toBe('Заявка создана');
    }
  });
});

describe('крупная строка «это заявка, а не бронь» — пока заявка ждёт оператора (13.11)', () => {
  // Слово владельца 13.11 «1 да». Экран после отправки говорил «Заявка
  // создана» под зелёной галочкой, а слов «не бронь» на нём не было: человек
  // читал его как «забронировано», оператор — как вопрос.
  const notice = () => document.querySelector('[data-not-booking]');

  it("'new': строка есть, стоит сразу под заголовком и выше карточки заявки", async () => {
    const { container } = await loaded(BASE);
    const box = notice();
    expect(box, 'строки нет').not.toBeNull();
    expect(box!.textContent).toMatch(/Это заявка, а не бронь/);
    expect(box!.textContent).toMatch(/До ответа оператора место не гарантировано/);
    const h1 = container.querySelector('h1')!;
    const card = screen.getByText('Номер заявки');
    expect(h1.compareDocumentPosition(box!) & Node.DOCUMENT_POSITION_FOLLOWING, 'строка выше заголовка').toBeTruthy();
    expect(box!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING, 'строка ниже карточки').toBeTruthy();
    // Между заголовком и строкой нет другого текста: подзаголовок идёт после.
    const sub = screen.getByText(/Мы передали заявку оператору/);
    expect(box!.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING, 'подзаголовок раньше строки').toBeTruthy();
  });

  it('строка крупнее подзаголовка и жирная', async () => {
    await loaded(BASE);
    const title = screen.getByText('Это заявка, а не бронь');
    expect(title.className).toMatch(/\btext-lg\b/);
    expect(title.className).toMatch(/\bfont-bold\b/);
    const sub = screen.getByText(/Мы передали заявку оператору/);
    expect(sub.className).toMatch(/\btext-sm\b/);
  });

  it('про место сказано только «не гарантировано»: «закреплено» у тура с календарём было бы неправдой', async () => {
    // Новая заявка места в календаре занимает сразу (lib/bookings/occupancy),
    // поэтому «не закреплено» экран не говорит; «закреплено» — тем более.
    await loaded(BASE);
    expect(text()).not.toMatch(/закреплен/i);
    expect(text()).not.toMatch(/забронирован/i);
  });

  it('оператор подтвердил — строки нет', async () => {
    for (const status of ['confirmed', 'pending_payment']) {
      await loaded({ ...BASE, status });
      expect(notice(), status).toBeNull();
      expect(text(), status).not.toMatch(/а не бронь/);
      cleanup();
    }
  });

  it('отменена, завершена, неизвестный статус — строки нет', async () => {
    for (const status of ['cancelled', 'completed', 'rejected', 'что-то новое']) {
      await loaded({ ...BASE, status });
      expect(notice(), status).toBeNull();
      cleanup();
    }
  });

  it("'new', но оплата уже отмечена — строки нет: экран говорит «Оплата получена»", async () => {
    await loaded({ ...BASE, payment_status: 'paid' });
    expect(text()).toMatch(/Оплата получена/);
    expect(notice()).toBeNull();
    expect(text()).not.toMatch(/Что дальше/);
  });

  it('пока заявка не прочитана и когда она не открылась — строки нет', async () => {
    render(<BookingSuccessClient />);
    await flush();
    expect(text()).toMatch(/Проверяем заявку…/);
    expect(notice()).toBeNull();
    cleanup();
    window.history.replaceState({}, '', '/booking-success/1');
    render(<BookingSuccessClient />);
    await flush();
    expect(text()).toMatch(/Заявка не найдена/);
    expect(notice()).toBeNull();
  });

  it('правило одно на строку и на блок «Что дальше»', async () => {
    expect(awaitsOperator({ status: 'new', alreadyPaid: false })).toBe(true);
    expect(awaitsOperator({ status: 'new', alreadyPaid: true })).toBe(false);
    expect(awaitsOperator({ status: 'confirmed', alreadyPaid: false })).toBe(false);
    expect(awaitsOperator({ status: null, alreadyPaid: false })).toBe(false);
    expect(notBookingNotice({ status: 'new', alreadyPaid: false })?.title).toBe('Это заявка, а не бронь');
    expect(notBookingNotice({ status: 'new', alreadyPaid: true })).toBeNull();
    expect(notBookingNotice({ status: undefined, alreadyPaid: false })).toBeNull();
    // Там, где есть строка, есть и шаги; где её нет — нет и шагов.
    await loaded(BASE);
    expect(notice()).not.toBeNull();
    expect(text()).toMatch(/Что дальше/);
    cleanup();
    await loaded({ ...BASE, status: 'confirmed' });
    expect(notice()).toBeNull();
    expect(text()).not.toMatch(/Что дальше/);
  });
});

describe('«контакты ниже» — только когда они ниже есть', () => {
  it('без контактов: «по телефону, который вы указали», блока «Оператор» нет', async () => {
    await loaded(BASE);
    expect(text()).toMatch(/по телефону, который вы указали/);
    expect(text()).not.toMatch(/контакт\S* ниже/);
  });

  it('без контактов, подтверждено, способов оплаты нет — то же', async () => {
    await loaded({ ...BASE, status: 'confirmed' });
    expect(text()).toMatch(/Онлайн-оплата недоступна/);
    expect(text()).toMatch(/по телефону, который вы указали/);
    expect(text()).not.toMatch(/контакт\S* ниже/);
  });

  it('с телефоном оператора: «контактам ниже» и сам блок', async () => {
    await loaded({ ...BASE, status: 'confirmed', operator_phone: '+74150000000' });
    expect(text()).toMatch(/по его контактам ниже/);
    expect(screen.getByText('+74150000000').closest('a')?.getAttribute('href')).toBe('tel:+74150000000');
    expect(hasOperatorContacts({ operator_phone: '  ', operator_telegram: null })).toBe(false);
  });

  it('дата не переносится', async () => {
    await loaded(BASE);
    const date = screen.getByText(/28 сентября 2026/);
    expect(date.className).toMatch(/whitespace-nowrap/);
    expect(date.textContent).not.toMatch(/г\.$/);
  });
});

describe('на странице общая шапка с SOS', () => {
  it('page.tsx монтирует Header, своей SOS нет', () => {
    const page = readFileSync(join(process.cwd(), 'app/booking-success/[id]/page.tsx'), 'utf-8');
    const client = readFileSync(join(process.cwd(), 'app/booking-success/[id]/_BookingSuccessClient.tsx'), 'utf-8');
    expect(page).toMatch(/<Header\b/);
    expect(page + client).not.toMatch(/<EmergencyAction\b/);
  });
});

describe('PDF заявки: «к оплате» — не раньше подтверждения', () => {
  it("ваучер и договор различают 'new' и ждущую оплаты бронь", () => {
    const voucher = readFileSync(join(process.cwd(), 'lib/pdf/voucher-generator.ts'), 'utf-8');
    const contract = readFileSync(join(process.cwd(), 'lib/pdf/contract-generator.ts'), 'utf-8');
    const route = readFileSync(join(process.cwd(), 'app/api/hub/bookings/[id]/pdf/route.ts'), 'utf-8');
    expect(voucher).toMatch(/bookingStatus === 'new'[\s\S]{0,80}ЖДЁТ ПОДТВЕРЖДЕНИЯ/);
    expect(contract).toMatch(/bookingStatus === 'new' \? 'Ждёт подтверждения оператора'/);
    expect(route.match(/bookingStatus: r\.booking_status/g)?.length, 'статус брони не доходит до обоих PDF').toBe(2);
  });
});
