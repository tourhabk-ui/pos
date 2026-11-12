// @vitest-environment jsdom
/**
 * Страница заявки `/request-status#<ключ>` — рендером (#2371, 14.10).
 *
 * Заявка на жильё: своего ответа у неё нет — владелец звонит гостю сам. Страница
 * говорит «передана» и не обещает «ждём ответа оператора»; ведёт на карточку
 * объекта, где телефон владельца; галочка согласия — текстом «владельцу
 * жилья». Заявка на машину — текстом «перевозчику»: до 14.10 страница
 * показывала всем «туроператору», и согласие молчало о настоящем получателе.
 *
 * Подменена только сеть: страница получает ответ роута статуса в той форме,
 * что отдаёт GET /api/requests/status.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { RequestStatusClient } from '@/app/request-status/_RequestStatusClient';
import { PD_CONSENT_TEXT, PD_CONSENT_STAY_TEXT, PD_CONSENT_CARRIER_TEXT } from '@/lib/legal/pd-consent';

const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const CARD = 'https://vedarai.ru/accommodations/3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';

const STAY_VIEW = {
  state: 'delivered', kind: 'stay_request', tour: null,
  accommodation: 'Кутха', accommodation_url: CARD,
  date: '2027-07-10', check_out: '2027-07-12', participants: 9,
  alt_date: null, deadline: null,
  human: 'Заявка передана владельцу жилья в мессенджер. Владелец отвечает звонком по телефону из заявки, и его ответа платформа не видит.',
  consent: 'agent', consent_purpose: 'stay',
};

const CHARTER_VIEW = {
  state: 'awaiting_operator', kind: 'lead', tour: null,
  accommodation: null, accommodation_url: null,
  date: null, check_out: null, participants: null,
  alt_date: null, deadline: null,
  human: 'Заявка принята, перевозчик ещё не ответил.',
  consent: 'agent', consent_purpose: 'carrier',
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();


function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function serve(view: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url) => {
    if (url.startsWith('/api/requests/status')) return json({ success: true, data: view });
    if (url === '/api/requests/consent') return json({ success: true, data: { consent: 'human', recorded: true } });
    return json({ success: false }, 404);
  });
}

// Фрагмент ставится один раз до рендера, и его hashchange успевает прийти:
// событие, пришедшее после монтирования, страница приняла бы за смену заявки.
beforeAll(async () => {
  window.location.hash = `#${KEY}`;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('страница заявки на жильё', () => {
  it('«передана», объект, даты и гости; не «ждём ответа оператора»', async () => {
    serve(STAY_VIEW);
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Заявка передана' })).toBeInTheDocument();
    // С 12.11 объект, даты и гости — на билете заявки, а не строкой под заголовком.
    const ticket = screen.getByRole('region', { name: 'Заявка' });
    expect(ticket.textContent).toMatch(/Кутха/);
    expect(ticket.textContent).toMatch(/Заезд10 июля 2027/);
    expect(ticket.textContent).toMatch(/Выезд12 июля 2027/);
    expect(ticket.textContent).toMatch(/Гостей9/);
    expect(ticket.textContent).toMatch(/Это заявка, а не бронь: подтверждает владелец жилья/);
    expect(screen.getByText(STAY_VIEW.human)).toBeInTheDocument();
    expect(screen.getByText(/Владелец позвонит по телефону из заявки/)).toBeInTheDocument();
    expect(screen.queryByText(/Ждём ответа оператора/)).not.toBeInTheDocument();
    // Статус спрошен с ключом из фрагмента адреса.
    // seen=1 — вкладка на виду (план «после отказа», 2б): так страница отмечает, что ответ увиден.
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/requests/status?k=${KEY}&seen=1`);
  });

  it('ведёт на карточку объекта и в раздел жилья, а не в каталог туров', async () => {
    serve(STAY_VIEW);
    render(<RequestStatusClient />);
    const card = await screen.findByRole('link', { name: 'Карточка объекта' });
    expect(card).toHaveAttribute('href', CARD);
    expect(screen.getByRole('link', { name: 'Жильё' })).toHaveAttribute('href', '/accommodations');
    expect(screen.queryByRole('link', { name: 'Каталог туров' })).not.toBeInTheDocument();
  });

  it('галочка — согласие на передачу владельцу жилья; подтверждение уходит с ключом и галочкой человека', async () => {
    serve(STAY_VIEW);
    render(<RequestStatusClient />);
    const box = await screen.findByRole('checkbox');
    expect(box.closest('label')).toHaveTextContent(PD_CONSENT_STAY_TEXT);
    expect(box.closest('label')).not.toHaveTextContent(PD_CONSENT_TEXT);

    const button = screen.getByRole('button', { name: 'Подтвердить согласие' });
    expect(button).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(button);
    expect(await screen.findByText('Согласие записано.')).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url]) => url === '/api/requests/consent');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ key: KEY, pd_consent: true });
  });

  it('не дошла до владельца — так и сказано, со звонком владельцу, а не оператору', async () => {
    serve({ ...STAY_VIEW, state: 'failed', human: 'Заявка записана, но не дошла ни владельцу, ни оператору Ведара.' });
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Заявка не дошла до владельца' })).toBeInTheDocument();
    expect(screen.getByText('Позвоните владельцу сами: телефон на карточке объекта.')).toBeInTheDocument();
    expect(screen.queryByText(/Ответ оператора не записался/)).not.toBeInTheDocument();
  });
});

describe('страница заявки на машину', () => {
  it('галочка — согласие на передачу перевозчику, а не туроператору', async () => {
    serve(CHARTER_VIEW);
    render(<RequestStatusClient />);
    const box = await screen.findByRole('checkbox');
    expect(box.closest('label')).toHaveTextContent(PD_CONSENT_CARRIER_TEXT);
    expect(box.closest('label')).not.toHaveTextContent(PD_CONSENT_TEXT);
  });

  // До 11.11 заявка на машину говорила «Ждём ответа оператора» и звала в
  // каталог туров (план «после отказа», этап 1): адресат — перевозчик.
  it('ждёт перевозчика, а не оператора, и ведёт к трансферам, а не в каталог туров', async () => {
    serve(CHARTER_VIEW);
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Ждём ответа перевозчика' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Трансферы' })).toHaveAttribute('href', '/transfers');
    expect(screen.queryByRole('link', { name: 'Каталог туров' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Оператор свяжется|ответа оператора/)).not.toBeInTheDocument();
    expect(screen.getByText(/Перевозчик свяжется по телефону из заявки/)).toBeInTheDocument();
  });

  it('отказ перевозчика — других перевозчиков ищут на странице трансферов', async () => {
    serve({ ...CHARTER_VIEW, state: 'declined', human: 'Перевозчик ответил: выполнить заявку не может. Менеджер Ведара получил об этом сообщение.' });
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Перевозчик отказал по заявке' })).toBeInTheDocument();
    expect(screen.getByText(/Других перевозчиков и цены по направлению смотрите на странице трансферов/)).toBeInTheDocument();
    expect(screen.queryByText(/другой тур/)).not.toBeInTheDocument();
  });
});

describe('страница заявки на прокат', () => {
  it('ждёт прокатчика и ведёт в прокат машин', async () => {
    serve({ ...CHARTER_VIEW, consent_purpose: 'rental', human: 'Заявка принята, прокатчик ещё не ответил.' });
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Ждём ответа прокатчика' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Прокат машин' })).toHaveAttribute('href', '/car-rental');
  });
});

describe('страница заявки на жильё: ответ владельца кнопкой (1359)', () => {
  it('«Занято» — отказ владельца и другое жильё, а не «передана»', async () => {
    serve({ ...STAY_VIEW, state: 'declined', human: 'Владелец ответил: на эти даты занято.' });
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Владелец ответил: занято' })).toBeInTheDocument();
    expect(screen.getByText('Другое жильё на эти даты — на странице жилья.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Жильё' })).toHaveAttribute('href', '/accommodations');
  });

  it('«Свободно, беру» — владелец ответил, это не бронь', async () => {
    serve({ ...STAY_VIEW, state: 'in_progress', human: 'Владелец ответил: на эти даты свободно, заявку берёт. Это не бронь: даты и цену он подтвердит звонком или в переписке.' });
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Владелец ответил' })).toBeInTheDocument();
    expect(screen.queryByText(/у оператора/)).not.toBeInTheDocument();
  });
});

describe('страница заявки на тур: тексты оператора прежние', () => {
  it('ждём ответа оператора и каталог туров', async () => {
    serve({ ...CHARTER_VIEW, consent_purpose: 'operator', human: 'Заявка принята, оператор ещё не ответил.' });
    render(<RequestStatusClient />);
    expect(await screen.findByRole('heading', { name: 'Ждём ответа оператора' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Каталог туров' })).toHaveAttribute('href', '/catalog'));
  });
});
