// @vitest-environment jsdom
/**
 * «Другие компании к месту на вашу дату» на странице заявки — рендером (план
 * «после отказа», этап 4а, второй срез).
 *
 * Держит то, что видит человек: компании названы по порядку, у каждой — тур,
 * цена как факт, что известно о местах и ссылка на форму ЕЁ тура; сказано, что
 * это не ответ компаний и что телефон получит только выбранная; правило
 * порядка — последней строкой; «не нашлось» — блока нет; «не прочиталось» —
 * строка об этом, а не пустота. Слова — те же, что в сообщении в чате.
 *
 * Страница целиком — с подменённой сетью: блок стоит на странице заявки после
 * ответа оператора и не появляется у заявки, к которой не относится.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { RequestOtherOffers, OTHER_OFFERS_FAILED_RU, type OtherOffersBlock } from '@/components/requests/RequestOtherOffers';
import { RequestStatusClient } from '@/app/request-status/_RequestStatusClient';
import { OTHER_OFFERS_NOT_ANSWER_RU, otherOfferSeatsWords } from '@/lib/requests/other-offers-words';
import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';
import { touristAnswerText, type NoticeFacts } from '@/lib/requests/answer-notice-text';

const FORM_A = 'https://vedarai.ru/catalog/tours/gorely-za-den?date=2027-01-15&guests=3#booking';
const FORM_B = 'https://vedarai.ru/catalog/tours/202?date=2027-01-15&guests=3#booking';
const PLACE_URL = 'https://vedarai.ru/places/gorely#tours';

const LISTED: OtherOffersBlock = {
  state: 'listed', place: 'Вулкан Горелый', place_url: PLACE_URL, date: '2027-01-15', participants: 3,
  offers: [
    { company: 'Компания «А&Б»', tour: 'Горелый за день', tour_id: '201', price: '12 000 ₽ за человека', seats: 'calendar', url: FORM_A, more_tours: 2 },
    { company: 'Вторая', tour: 'К кратеру', tour_id: '202', price: null, seats: 'by_request', url: FORM_B, more_tours: 0 },
  ],
  more_companies: 1,
};

beforeEach(() => { cleanup(); });

describe('блок «другие компании»', () => {
  it('названы: по строке на компанию — тур, цена, места и ссылка на форму её тура', () => {
    render(<RequestOtherOffers block={LISTED} />);
    const section = screen.getByRole('region', { name: 'К месту «Вулкан Горелый» на 15 января 2027 г. — другие компании' });
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('1. Компания «А&Б»');
    expect(rows[0]!.textContent).toContain('Тур «Горелый за день» · 12 000 ₽ за человека');
    expect(rows[0]!.textContent).toContain('В календаре на эту дату места на 3 чел. есть; у компании к этому месту ещё 2 тура.');
    expect(rows[1]!.textContent).toContain('2. Вторая');
    expect(rows[1]!.textContent).toContain('Тур «К кратеру» · цена не указана');
    expect(rows[1]!.textContent).toContain('Расписания на Ведаре нет — дату подтверждает оператор.');
    // Ссылка каждой строки — форма тура ЭТОЙ компании, с датой и людьми.
    expect(within(rows[0]!).getByRole('link', { name: 'Оставить заявку: Компания «А&Б», тур «Горелый за день»' })).toHaveAttribute('href', FORM_A);
    expect(within(rows[1]!).getByRole('link', { name: 'Оставить заявку: Вторая, тур «К кратеру»' })).toHaveAttribute('href', FORM_B);
  });

  it('сказано, что это не ответ компаний и кому уйдёт телефон; порядок назван правилом; оценок нет', () => {
    render(<RequestOtherOffers block={LISTED} />);
    const section = screen.getByRole('region');
    expect(within(section).getByText(OTHER_OFFERS_NOT_ANSWER_RU)).toBeInTheDocument();
    expect(within(section).getByText(OFFER_ORDER_NOTE_ON_DATE_RU)).toBeInTheDocument();
    expect(OFFER_ORDER_NOTE_ON_DATE_RU).toMatch(/Место в списке не продаётся\.$/);
    // Правило порядка — после списка и после слов «не ответ компаний».
    const text = section.textContent ?? '';
    expect(text.indexOf(OTHER_OFFERS_NOT_ANSWER_RU)).toBeGreaterThan(text.indexOf('Вторая'));
    expect(text.indexOf(OFFER_ORDER_NOTE_ON_DATE_RU)).toBeGreaterThan(text.indexOf(OTHER_OFFERS_NOT_ANSWER_RU));
    expect(text).not.toMatch(/рекоменд|лучш|дешевл|выгодн|советуем/i);
  });

  it('компании, не вошедшие в список, — числом и ссылкой на страницу места', () => {
    render(<RequestOtherOffers block={LISTED} />);
    expect(screen.getByText(/Ещё 1 компания —/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'на странице места' })).toHaveAttribute('href', PLACE_URL);
    cleanup();
    render(<RequestOtherOffers block={{ ...LISTED, more_companies: 0 }} />);
    expect(screen.queryByText(/Ещё \d+ компан/)).not.toBeInTheDocument();
  });

  it('число людей не записано — «места есть» без выдуманного числа', () => {
    render(<RequestOtherOffers block={{ ...LISTED, participants: null }} />);
    const first = screen.getAllByRole('listitem')[0]!;
    expect(first.textContent).toContain('В календаре на эту дату места есть');
    expect(first.textContent).not.toMatch(/на \d+ чел/);
  });

  it('не нашлось — блока нет; не прочиталось — строка об этом, а не пустота', () => {
    const none = render(<RequestOtherOffers block={{ ...LISTED, state: 'none', offers: [], place: null, place_url: null, more_companies: 0 }} />);
    expect(none.container).toBeEmptyDOMElement();
    cleanup();
    const absent = render(<RequestOtherOffers block={null} />);
    expect(absent.container).toBeEmptyDOMElement();
    cleanup();
    render(<RequestOtherOffers block={{ ...LISTED, state: 'failed', offers: [], place: null, place_url: null, more_companies: 0 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(OTHER_OFFERS_FAILED_RU);
    expect(OTHER_OFFERS_FAILED_RU).toContain('не значит, что их нет');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('ссылка — только на сайт: чужая схема адреса кнопкой не становится', () => {
    render(<RequestOtherOffers block={{
      ...LISTED,
      place_url: 'javascript:alert(1)',
      offers: [
        { ...LISTED.offers[0]!, url: 'javascript:alert(1)' },
        { ...LISTED.offers[1]!, url: '//evil.example/x' },
      ],
    }} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('слова о местах — те же, что в сообщении человеку в чат', () => {
    const f: NoticeFacts = {
      leadId: 'L', kind: 'tour', answer: 'no_seats', reason: null, tourTitle: 'Вулкан Горелый', tourUrl: null,
      date: '2027-01-15', people: 3, operatorName: 'Первая', groupPassedOn: false,
    };
    const chat = touristAnswerText(f, { kind: 'skip' }, false, {
      kind: 'offers', placeName: 'Вулкан Горелый', placeUrl: PLACE_URL, more: 0,
      offers: [
        { partnerName: 'А', tourId: '201', title: 'Горелый за день', price: null, seats: 'calendar', url: FORM_A, moreTours: 0 },
        { partnerName: 'Б', tourId: '202', title: 'К кратеру', price: null, seats: 'by_request', url: FORM_B, moreTours: 0 },
      ],
    }).text;
    expect(chat).toContain(otherOfferSeatsWords('calendar', 3));
    expect(chat).toContain(otherOfferSeatsWords('by_request', 3));
    expect(chat).toContain(OTHER_OFFERS_NOT_ANSWER_RU);
  });
});

describe('страница заявки целиком', () => {
  const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const DECLINED = {
    state: 'declined', kind: 'lead', tour: 'Вулкан Горелый',
    accommodation: null, accommodation_url: null,
    date: null, check_out: null, participants: 3, alt_date: null, deadline: null,
    human: 'Оператор ответил: на 15.01.2027 мест нет.',
    consent: 'human', consent_purpose: 'operator',
  };
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const serve = (view: Record<string, unknown>) => fetchMock.mockImplementation(async (url) => (
    String(url).startsWith('/api/requests/status')
      ? new Response(JSON.stringify({ success: true, data: view }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ success: false }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  ));

  beforeAll(async () => {
    window.location.hash = `#${KEY}`;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('после «мест нет» под ответом оператора стоят другие компании', async () => {
    serve({ ...DECLINED, other_offers: LISTED });
    render(<RequestStatusClient />);
    expect(await screen.findByText(DECLINED.human)).toBeInTheDocument();
    const section = screen.getByRole('region', { name: /другие компании$/ });
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    // Блок — после ответа оператора, а не вместо него.
    const order = screen.getByText(DECLINED.human).compareDocumentPosition(section);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('у заявки без списка блока нет: поле пустое или его нет вовсе', async () => {
    serve({ ...DECLINED, other_offers: null });
    render(<RequestStatusClient />);
    expect(await screen.findByText(DECLINED.human)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /другие компании/ })).not.toBeInTheDocument();
    cleanup();
    serve(DECLINED);
    render(<RequestStatusClient />);
    expect(await screen.findByText(DECLINED.human)).toBeInTheDocument();
    expect(screen.queryByText(/другие компании/)).not.toBeInTheDocument();
  });
});
