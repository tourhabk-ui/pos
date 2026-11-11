/**
 * Раздел «Свои туры» кабинета гида (28.10, владелец: «Раздел в кабинете
 * гида») — рендером и вызовом.
 *
 *   — бронь своего тура видна с контактами туриста; кнопки — из тех же
 *     переходов, что проверяет сервер (ALLOWED_TRANSITIONS);
 *   — отклонить без причины нельзя: кнопка «Да» не нажимается, пока причины
 *     нет, и причина уходит в PATCH;
 *   — список, который не прочитался (null), — «не загрузились», а не «пусто»
 *     (§4.0);
 *   — даты открываются только у опубликованных туров, черновик назван
 *     черновиком;
 *   — личные сообщения ведут гида в «Свои туры», а оператора — в его кабинет
 *     (lib/partners/cabinet-links);
 *   — заявка своего тура отмечается в два шага (29.10): кнопка, затем «Да»;
 *     PATCH уходит в дверь гида с выбранной отметкой, повтор назван повтором;
 *   — бронь рукой (#3211): «Записать бронь» в «Бронях» и «Завести бронь» под
 *     заявкой — форма, затем «Записать бронь»; из заявки форма берёт только
 *     записанное (контакты, люди, тур и дата), POST уходит в дверь гида с
 *     номером заявки; под заявкой — её брони; отказ сервера — его словами.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import OwnToursClient, { actionsFor, STATUS_LABEL } from '@/app/hub/guide/own/_OwnToursClient';
import { LEAD_STATUS_WORDS, OWNER_LEAD_ACTION_LABEL, OWNER_LEAD_STATUSES } from '@/lib/leads/owner-lead-words';
import { ownerBookingsListUrl, ownerBookingsUrl, ownerLeadUrl } from '@/lib/partners/cabinet-links';
import { ALLOWED_TRANSITIONS } from '@/types/booking.types';

const TOUR = {
  id: '101', title: 'Толбачик, 4 дня', slug: 'tolbachik', is_published: true, is_active: true,
  base_price: '85000', price_unit: 'per_person', max_participants: 4, short_description: null, description: 'Четыре дня.',
  season_start: '2027-07-26', season_end: '2027-09-23', open_dates: 5, on_storefront: true, blockers: [] as string[],
};
const DRAFT = {
  ...TOUR, id: '102', title: 'Бухта Русская', slug: 'russkaya', is_published: false, open_dates: 0,
  description: null, on_storefront: false, blockers: ['description'],
};
const BOOKING = {
  id: '7001', tour_id: '101', tour_title: 'Толбачик, 4 дня', booking_date: '2027-07-26', participants: 2,
  booking_status: 'new', tourist_name: 'Пётр', tourist_phone: '+79990001122', tourist_email: null,
  special_requests: 'Вегетарианское питание', created_at: '2026-10-28',
};
const LEAD = {
  id: '6f1c2a10-0000-4000-8000-000000000001', created_at: '2026-10-27T10:00:00Z', status: 'new',
  name: 'Ольга', phone: '+79990003344', email: null, comment: 'Хотим на Толбачик вдвоём', desired_dates: 'конец июля', group_size: 2,
};

type Reply = { ok: boolean; status?: number; body: unknown };
let ownReply: Reply;
let patchReply: Reply;
let postReply: Reply;
let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  ownReply = { ok: true, body: { success: true, data: { tours: [TOUR, DRAFT], bookings: [BOOKING], leads: [] } } };
  patchReply = { ok: true, body: { success: true, data: {}, tourist_notice: 'sent' } };
  postReply = { ok: true, status: 201, body: { success: true, data: { id: '7002', lead_id: null } } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : null });
    const r = method === 'PATCH' ? patchReply : method === 'POST' && String(url) === '/api/guide/own/bookings' ? postReply : ownReply;
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«Свои туры» гида', () => {
  it('кнопки брони — ровно разрешённые сервером переходы', () => {
    for (const [from, to] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect([...actionsFor(from)].sort()).toEqual([...to].sort());
    }
    expect(actionsFor('неизвестный')).toEqual([]);
  });

  it('новая бронь своего тура — с контактами туриста; подтверждение уходит PATCH-ем в раздел гида', async () => {
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    expect(within(row).getByText('Толбачик, 4 дня')).toBeTruthy();
    expect(within(row).getByText(STATUS_LABEL.new)).toBeTruthy();
    expect(within(row).getByText('Пётр')).toBeTruthy();
    expect(within(row).getByRole('link', { name: /\+79990001122/ }).getAttribute('href')).toBe('tel:+79990001122');
    expect(within(row).getByText(/Вегетарианское питание/)).toBeTruthy();
    // Для новой — только «Подтвердить» и «Отклонить».
    expect(within(row).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Подтвердить', 'Отклонить']);

    fireEvent.click(within(row).getByRole('button', { name: 'Подтвердить' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, подтвердить/ }));
    await screen.findByText(/Бронь №7001: подтверждена\./);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toEqual({ url: '/api/guide/own/bookings/7001', method: 'PATCH', body: { booking_status: 'confirmed' } });
  });

  it('отклонить без причины нельзя; причина уходит туристу', async () => {
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    fireEvent.click(within(row).getByRole('button', { name: 'Отклонить' }));
    const yes = within(row).getByRole('button', { name: /Да, отклонить/ }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    fireEvent.change(within(row).getByLabelText(/Причина/), { target: { value: 'Закрыт подъезд к вулкану' } });
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ booking_status: 'cancelled', cancellation_reason: 'Закрыт подъезд к вулкану' });
  });

  // 29.10: второе нажатие (другая вкладка, повтор) — сервер отвечает
  // changed:false и туристу ничего не шлёт; экран не говорит «подтверждена»,
  // как будто письмо ушло сейчас.
  it('бронь уже в этом статусе — «уже подтверждена, туристу повторно ничего не отправлено»', async () => {
    patchReply = { ok: true, body: { success: true, data: {}, changed: false, tourist_notice: null } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    fireEvent.click(within(row).getByRole('button', { name: 'Подтвердить' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, подтвердить/ }));
    await screen.findByText('Бронь №7001 уже подтверждена — туристу повторно ничего не отправлено.');
    expect(screen.queryByText(/Бронь №7001: подтверждена\./)).toBeNull();
  });

  it('отказ сервера назван словами сервера, бронь не помечена изменённой', async () => {
    patchReply = { ok: false, status: 409, body: { success: false, error: 'Из статуса «cancelled» так перевести бронь нельзя' } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    fireEvent.click(within(row).getByRole('button', { name: 'Подтвердить' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, подтвердить/ }));
    expect((await within(row).findByRole('alert')).textContent).toContain('так перевести бронь нельзя');
    expect(screen.queryByText(/Бронь №7001: подтверждена/)).toBeNull();
  });

  it('не прочитанный список — «не загрузились», пустой — «пока нет»', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR], bookings: null, leads: [] } } };
    render(<OwnToursClient />);
    expect((await screen.findByText(/Брони не загрузились/)).getAttribute('role')).toBe('alert');
    expect(screen.queryByText('Броней пока нет.')).toBeNull();
    expect(screen.getByText('Заявок пока нет.')).toBeTruthy();
  });

  it('даты — только у опубликованных туров; черновик назван черновиком', async () => {
    render(<OwnToursClient />);
    await screen.findByTestId('own-booking-7001');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Толбачик, 4 дня']);
    expect(screen.getByRole('link', { name: 'Толбачик, 4 дня' }).getAttribute('href')).toBe('/catalog/tours/101');
    // Черновик назван черновиком — в «Моих турах» (31.10), без ссылки на сайт.
    expect(screen.getByTestId('own-tour-102').textContent).toContain('черновик — туристы не видят');
    expect(within(screen.getByTestId('own-tour-102')).queryByRole('link')).toBeNull();
  });
});

describe('заявки своего тура: отметка ответа в два шага (29.10)', () => {
  const withLead = (lead: Record<string, unknown>) => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR], bookings: [], leads: [lead] } } };
  };

  it('новая заявка — с контактами и статусом; «Связался» → вопрос → «Да» — PATCH в дверь гида с этой отметкой', async () => {
    withLead(LEAD);
    patchReply = { ok: true, body: { success: true, changed: true, data: { id: LEAD.id, status: 'contacted' } } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    expect(within(row).getByText(LEAD_STATUS_WORDS.new)).toBeTruthy();
    expect(within(row).getByRole('link', { name: /\+79990003344/ }).getAttribute('href')).toBe('tel:+79990003344');
    expect(within(row).getByText(/Даты: конец июля/)).toBeTruthy();
    // Отметки — все четыре, ни одна не уходит без «Да»; рядом — «Завести бронь» (#3211).
    expect(within(row).getAllByRole('button').map((b) => b.textContent?.trim()))
      .toEqual([...OWNER_LEAD_STATUSES.map((st) => OWNER_LEAD_ACTION_LABEL[st]), 'Завести бронь']);

    fireEvent.click(within(row).getByRole('button', { name: 'Связался' }));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const question = within(row).getByText(/Отметить заявку: «Связался»\?/);
    expect(question.textContent).toContain('Туристу ничего не отправляется.');
    expect(question.textContent).toContain('Заявка уйдёт из «Входящих».');

    fireEvent.click(within(row).getByRole('button', { name: /Да, отметить/ }));
    await screen.findByText(/Заявка от .*: «Вы связались»\./);
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      url: `/api/guide/own/leads/${LEAD.id}`, method: 'PATCH', body: { status: 'contacted' },
    });
  });

  it('«Назад» — ничего не уходит; отметка, которая уже стоит, не предлагается, а заявка не из «Входящих» не обещает уйти оттуда', async () => {
    withLead({ ...LEAD, status: 'contacted' });
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    expect(within(row).getByText(LEAD_STATUS_WORDS.contacted)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Связался' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Договорились' }));
    expect(within(row).getByText(/Отметить заявку: «Договорились»\?/).textContent).not.toContain('«Входящих»');
    fireEvent.click(within(row).getByRole('button', { name: 'Назад' }));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(within(row).getByRole('button', { name: 'Договорились' })).toBeTruthy();
  });

  it('повтор — «уже отмечена, ничего не изменено»; отказ сервера — его словами, без «отмечено»', async () => {
    withLead(LEAD);
    patchReply = { ok: true, body: { success: true, changed: false, data: { id: LEAD.id, status: 'lost' } } };
    render(<OwnToursClient />);
    let row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Отказ' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, отметить/ }));
    await screen.findByText('Заявка уже отмечена: «Отказ» — ничего не изменено.');
    cleanup();

    patchReply = { ok: false, status: 404, body: { success: false, error: 'Заявка не найдена среди ваших' } };
    render(<OwnToursClient />);
    row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Отказ' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, отметить/ }));
    expect((await within(row).findByRole('alert')).textContent).toBe('Заявка не найдена среди ваших');
    expect(screen.queryByText(/Заявка от .*: «/)).toBeNull();
  });
});

describe('бронь рукой (#3211): по звонку и из заявки', () => {
  const LEAD_FOR_BOOKING = {
    ...LEAD, group_size: null, people: 3, tour_id: '101', requested_date: '2027-07-26', email: 'olga@example.com', bookings: [],
  };

  it('«Записать бронь» — форма; без даты и людей кнопка не нажимается; POST уходит в дверь гида без заявки', async () => {
    render(<OwnToursClient />);
    await screen.findByTestId('own-booking-7001');
    fireEvent.click(screen.getByRole('button', { name: /Записать бронь/ }));
    const form = screen.getByTestId('booking-form-manual');
    const submit = within(form).getByRole('button', { name: /Записать бронь/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Черновик в списке туров назван черновиком.
    expect([...(within(form).getByLabelText('Тур') as HTMLSelectElement).options].map((o) => o.textContent))
      .toEqual(['Толбачик, 4 дня', 'Бухта Русская (черновик)']);
    expect(within(form).getByText(/Бронь запишется подтверждённой; туристу ничего не отправляется\./).textContent).not.toMatch(/Входящих/);
    fireEvent.change(within(form).getByLabelText('Дата поездки'), { target: { value: '2027-08-02' } });
    fireEvent.change(within(form).getByLabelText('Человек'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Имя туриста'), { target: { value: 'Иван' } });
    fireEvent.change(within(form).getByLabelText('Телефон'), { target: { value: '+79990005566' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await screen.findByText('Бронь №7002 записана: Толбачик, 4 дня, 2 августа 2027 г., 2 чел.');
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/guide/own/bookings', method: 'POST',
      body: { operator_tour_id: 101, booking_date: '2027-08-02', participants: 2, tourist_name: 'Иван', tourist_phone: '+79990005566' },
    });
    expect(screen.queryByTestId('booking-form-manual')).toBeNull();
  });

  it('«Завести бронь» из заявки — тур, дата, люди и контакты из заявки; POST с номером заявки; заявка станет «Договорились»', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR, DRAFT], bookings: [], leads: [LEAD_FOR_BOOKING] } } };
    postReply = { ok: true, status: 201, body: { success: true, data: { id: '7003', lead_id: LEAD.id } } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    expect(within(row).getByText('Человек: 3')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: /Завести бронь/ }));
    const form = within(row).getByTestId(`booking-form-lead-${LEAD.id}`);
    expect((within(form).getByLabelText('Тур') as HTMLSelectElement).value).toBe('101');
    expect((within(form).getByLabelText('Дата поездки') as HTMLInputElement).value).toBe('2027-07-26');
    expect((within(form).getByLabelText('Человек') as HTMLInputElement).value).toBe('3');
    expect((within(form).getByLabelText('Имя туриста') as HTMLInputElement).value).toBe('Ольга');
    expect((within(form).getByLabelText('Телефон') as HTMLInputElement).value).toBe('+79990003344');
    expect(within(form).getByText(/Заявка станет «Договорились» и уйдёт из «Входящих»\./)).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: /Записать бронь/ }));
    await screen.findByText('Бронь №7003 записана: Толбачик, 4 дня, 26 июля 2027 г., 3 чел. Заявка — «Договорились».');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      operator_tour_id: 101, booking_date: '2027-07-26', participants: 3,
      tourist_name: 'Ольга', tourist_phone: '+79990003344', tourist_email: 'olga@example.com', lead_id: LEAD.id,
    });
  });

  it('чего заявка не записала, форма не выдумывает: нет тура, даты и людей — поля пустые, кнопка не нажимается', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR], bookings: [], leads: [{ ...LEAD_FOR_BOOKING, people: null, tour_id: '999', requested_date: null }] } } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    fireEvent.click(within(row).getByRole('button', { name: /Завести бронь/ }));
    const form = within(row).getByTestId(`booking-form-lead-${LEAD.id}`);
    // Тур заявки не из туров гида — первый свой, а не чужой номер.
    expect((within(form).getByLabelText('Тур') as HTMLSelectElement).value).toBe('101');
    expect((within(form).getByLabelText('Дата поездки') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Человек') as HTMLInputElement).value).toBe('');
    expect((within(form).getByRole('button', { name: /Записать бронь/ }) as HTMLButtonElement).disabled).toBe(true);
    // И уходит именно свой тур, а не номер из заявки.
    fireEvent.change(within(form).getByLabelText('Дата поездки'), { target: { value: '2027-08-09' } });
    fireEvent.change(within(form).getByLabelText('Человек'), { target: { value: '2' } });
    fireEvent.click(within(form).getByRole('button', { name: /Записать бронь/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect((calls.find((c) => c.method === 'POST')?.body as { operator_tour_id: number }).operator_tour_id).toBe(101);
  });

  it('под заявкой — её брони со ссылкой на бронь в списке', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR], bookings: [], leads: [{ ...LEAD_FOR_BOOKING, status: 'converted', bookings: [{ id: '7003', booking_date: '2027-07-26', booking_status: 'confirmed' }] }] } } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    expect(within(row).getByText(/Брони по заявке:/).textContent).toMatch(/№7003 — 26 июля 2027 г\., подтверждена/);
    expect(within(row).getByRole('link', { name: '№7003' }).getAttribute('href')).toBe('#booking-7003');
  });

  it('отказ сервера — его словами в форме, «записана» не сказано, форма остаётся', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR], bookings: [], leads: [LEAD_FOR_BOOKING] } } };
    postReply = { ok: false, status: 404, body: { success: false, error: 'Заявка не найдена среди ваших' } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    fireEvent.click(within(row).getByRole('button', { name: /Завести бронь/ }));
    const form = within(row).getByTestId(`booking-form-lead-${LEAD.id}`);
    fireEvent.click(within(form).getByRole('button', { name: /Записать бронь/ }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Заявка не найдена среди ваших');
    expect(screen.queryByText(/записана:/)).toBeNull();
  });

  it('туры не загрузились — ни «Записать бронь», ни «Завести бронь»: выбрать тур не из чего', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: null, bookings: [], leads: [LEAD_FOR_BOOKING] } } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId(`own-lead-${LEAD.id}`);
    expect(within(row).queryByRole('button', { name: /Завести бронь/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Записать бронь/ })).toBeNull();
  });
});

describe('куда ведёт личное сообщение продавцу тура', () => {
  it('гида — в «Свои туры», оператора и неизвестного — в кабинет оператора', () => {
    expect(ownerBookingsUrl('guide', '7001')).toBe('https://vedarai.ru/hub/guide/own');
    expect(ownerBookingsListUrl('guide')).toBe('https://vedarai.ru/hub/guide/own');
    expect(ownerLeadUrl('guide', 'L1')).toBe('https://vedarai.ru/hub/guide/own');
    expect(ownerBookingsUrl('operator', '7001')).toBe('https://vedarai.ru/hub/operator/bookings/7001');
    expect(ownerBookingsListUrl(null)).toBe('https://vedarai.ru/hub/operator/bookings');
    expect(ownerLeadUrl(undefined, 'L1')).toBe('https://vedarai.ru/hub/operator/leads/L1');
  });
});
