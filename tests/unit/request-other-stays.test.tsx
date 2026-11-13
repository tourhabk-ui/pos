// @vitest-environment jsdom
/**
 * «Другое жильё на ваши даты» на странице заявки на жильё — рендером (план
 * «после отказа», этап 5).
 *
 * Держит то, что видит гость: объекты по порядку, у каждого — что известно о
 * ночах и цене и кнопка на карточку ЭТОГО объекта с датами; сказано, что это
 * не ответ хозяев и кому уйдёт телефон; правило порядка — последней строкой;
 * «не нашлось» — блока нет; «не прочиталось» — строка об этом, а не пустота.
 * Страница целиком — с подменённой сетью: блок стоит под ответом «занято» и не
 * появляется у заявки, к которой не относится.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { RequestOtherStays, OTHER_STAYS_FAILED_RU, type OtherStaysBlock } from '@/components/requests/RequestOtherStays';
import { RequestStatusClient } from '@/app/request-status/_RequestStatusClient';
import { OTHER_STAYS_LIMIT_NOTE_RU, OTHER_STAYS_NOT_ANSWER_RU, OTHER_STAYS_ORDER_NOTE_RU } from '@/lib/stay/other-stays-words';

const URL_A = 'https://vedarai.ru/accommodations/r-1?check_in=2027-07-10&check_out=2027-07-12&adults=2&children=0';
const URL_B = 'https://vedarai.ru/accommodations/q-1?check_in=2027-07-10&check_out=2027-07-12&adults=2&children=0';
const PATH_A = '/accommodations/r-1?check_in=2027-07-10&check_out=2027-07-12&adults=2&children=0';
const PATH_B = '/accommodations/q-1?check_in=2027-07-10&check_out=2027-07-12&adults=2&children=0';

const LISTED: OtherStaysBlock = {
  state: 'listed', zone: 'Авачинская зона', check_in: '2027-07-10', check_out: '2027-07-12', guests: 2,
  stays: [
    { name: 'Отель «Гейзер» & Ко', accommodation_id: 'r-1', type: 'Отель', dates: 'calendar', price_from: 6000, stay_total: 24000, url: URL_A },
    { name: 'Дом у реки', accommodation_id: 'q-1', type: null, dates: 'by_request', price_from: null, stay_total: null, url: URL_B },
  ],
};

beforeEach(() => { cleanup(); });

describe('блок «другое жильё»', () => {
  it('названо: по строке на объект — что известно о ночах и цене и кнопка на карточку этого объекта с датами', () => {
    render(<RequestOtherStays block={LISTED} />);
    const section = screen.getByRole('region', { name: 'Другое жильё с 10 июля по 12 июля — Авачинская зона' });
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('1. Отель «Гейзер» & Ко · Отель');
    expect(rows[0]!.textContent).toContain('В календаре на эти ночи номера на 2 гостей есть — 24 000 ₽ за все ночи.');
    expect(rows[1]!.textContent).toContain('2. Дом у реки');
    expect(rows[1]!.textContent).toContain('Номеров на Ведаре нет — даты и цену подтверждает хозяин.');
    // Цена не названа — нуля и «от 0 ₽» в строке нет.
    expect(rows[1]!.textContent).not.toMatch(/₽/);
    expect(within(rows[0]!).getByRole('link', { name: 'Оставить заявку: Отель «Гейзер» & Ко' })).toHaveAttribute('href', PATH_A);
    expect(within(rows[1]!).getByRole('link', { name: 'Оставить заявку: Дом у реки' })).toHaveAttribute('href', PATH_B);
  });

  it('сказано, что это не ответ хозяев и кому уйдёт телефон; порядок назван правилом после списка; оценок нет', () => {
    render(<RequestOtherStays block={LISTED} />);
    const section = screen.getByRole('region');
    expect(within(section).getByText(OTHER_STAYS_NOT_ANSWER_RU)).toBeInTheDocument();
    expect(within(section).getByText(OTHER_STAYS_ORDER_NOTE_RU)).toBeInTheDocument();
    const text = section.textContent ?? '';
    expect(text.indexOf(OTHER_STAYS_NOT_ANSWER_RU)).toBeGreaterThan(text.indexOf('Дом у реки'));
    expect(text.indexOf(OTHER_STAYS_ORDER_NOTE_RU)).toBeGreaterThan(text.indexOf(OTHER_STAYS_NOT_ANSWER_RU));
    expect(text).toMatch(/Место в списке не продаётся\.$/);
    // Список ограничен — об этом сказано, и рядом ссылка на весь каталог.
    expect(within(section).getByText(new RegExp(OTHER_STAYS_LIMIT_NOTE_RU.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Каталог жилья' })).toHaveAttribute('href', '/accommodations');
    expect(text).not.toMatch(/рекоменд|лучш|дешевл|выгодн|советуем/i);
  });

  it('не нашлось — блока нет; не прочиталось — строка об этом, а не пустота', () => {
    const none = render(<RequestOtherStays block={{ ...LISTED, state: 'none', zone: null, stays: [] }} />);
    expect(none.container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<RequestOtherStays block={null} />).container).toBeEmptyDOMElement();
    cleanup();
    render(<RequestOtherStays block={{ ...LISTED, state: 'failed', zone: null, stays: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent(OTHER_STAYS_FAILED_RU);
    expect(OTHER_STAYS_FAILED_RU).toContain('не значит, что его нет');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('ссылка — только на этот сайт: чужой хост в данных не уводит, адрес с чужой схемой кнопкой не становится', () => {
    render(<RequestOtherStays block={{ ...LISTED, stays: [{ ...LISTED.stays[0]!, url: 'https://evil.example/accommodations/r-1' }] }} />);
    const link = screen.getByRole('link', { name: /^Оставить заявку/ });
    expect(link).toHaveAttribute('href', '/accommodations/r-1');
    cleanup();
    render(<RequestOtherStays block={{ ...LISTED, stays: [{ ...LISTED.stays[0]!, url: 'javascript:alert(1)' }] }} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    // Объект назван, а кнопки заявки нет; ссылка на каталог — своя, на этот сайт.
    expect(screen.queryByRole('link', { name: /^Оставить заявку/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/accommodations']);
  });
});

describe('страница заявки целиком', () => {
  const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const BUSY = {
    state: 'declined', kind: 'stay_request', tour: null,
    accommodation: 'Кутха', accommodation_url: 'https://vedarai.ru/accommodations/3b2551c7-ed5c-47c8-bb93-41ca6a278c1e',
    date: '2027-07-10', check_out: '2027-07-12', participants: 2, alt_date: null, deadline: null,
    human: 'Владелец ответил: на эти даты занято.',
    consent: 'human', consent_purpose: 'stay',
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

  it('после «занято» под ответом владельца стоит другое жильё на те же ночи', async () => {
    serve({ ...BUSY, other_stays: LISTED });
    render(<RequestStatusClient />);
    expect(await screen.findByText(BUSY.human)).toBeInTheDocument();
    const section = screen.getByRole('region', { name: /^Другое жильё с 10 июля по 12 июля/ });
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    const order = screen.getByText(BUSY.human).compareDocumentPosition(section);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('заявка, к которой список не относится, блока не получает', async () => {
    serve({ ...BUSY, state: 'in_progress', human: 'Владелец ответил: на эти даты свободно, заявку берёт.', other_stays: null });
    render(<RequestStatusClient />);
    expect(await screen.findByText(/на эти даты свободно/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Другое жильё/ })).not.toBeInTheDocument();
  });
});
