/**
 * Стирание карточки клиента по обращению (152-ФЗ, #2327) — то, что видит и
 * нажимает администратор. Ответ на удаление аккаунта обещает человеку, что
 * карточку, которую удаление не стёрло, по письму сотрёт администратор; без
 * этой кнопки обещание было бы исходом без исполнителя (§10.09). Рендером:
 * основание обязательно и только структурой (дата и номер обращения — в
 * журнал навсегда, имени там быть не должно), стирание — только после
 * подтверждения, отказ сервера виден словами сервера и карточку не
 * перечитывает; экран до и после стирания говорит, что заявки и брони
 * карточки с их именем и телефоном остаются у партнёра, и карточка со стёртым
 * клиентом не подписывает источник его именем.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { EraseOnRequest } from '@/components/crm/EraseOnRequest';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = '00000000-0000-4000-8000-0000000000c1';

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const dateBox = () => screen.getByLabelText('Дата обращения');
const ticketBox = () => screen.getByLabelText('Номер обращения, если есть');
const startButton = () => screen.getByRole('button', { name: 'Стереть данные клиента' }) as HTMLButtonElement;
const SOURCES_STAY = 'Заявки и брони, связанные с карточкой, это не стирает: имя и телефон, записанные в них самих, остаются у партнёра.';

describe('стирание карточки по обращению', () => {
  it('без даты обращения или с номером не из цифр кнопка не нажимается и сервер не зовётся; свободного текста нет', () => {
    const calls = stubFetch(200, { success: true });
    render(<EraseOnRequest contactId={ID} onErased={() => undefined} />);
    expect(startButton().disabled).toBe(true);
    expect(screen.getByText('Укажите дату обращения.')).toBeTruthy();
    fireEvent.change(ticketBox(), { target: { value: 'Андрей' } });
    fireEvent.change(dateBox(), { target: { value: '2026-10-22' } });
    expect(startButton().disabled).toBe(true);
    expect(screen.getByText('Номер обращения — только цифры.')).toBeTruthy();
    // Поля для слов, куда вписалось бы имя человека, нет.
    expect(screen.queryByRole('textbox', { name: 'Основание' })).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('до стирания экран говорит, что заявки карточки остаются у партнёра с именем и телефоном', () => {
    stubFetch(200, { success: true });
    render(<EraseOnRequest contactId={ID} onErased={() => undefined} />);
    expect(screen.getByRole('region', { name: 'Обращение по персональным данным' }).textContent).toContain(SOURCES_STAY);
  });

  it('дата, номер, подтверждение — запрос на адрес стирания этой карточки, затем «стёрты» с оговоркой о заявках и перечитать карточку', async () => {
    const calls = stubFetch(200, { success: true, data: { events: 2, tasks: 1 } });
    const onErased = vi.fn();
    render(<EraseOnRequest contactId={ID} onErased={onErased} />);
    fireEvent.change(dateBox(), { target: { value: '2026-10-22' } });
    fireEvent.change(ticketBox(), { target: { value: ' 17 ' } });
    fireEvent.click(startButton());
    // Первое нажатие ничего не стирает — только спрашивает.
    expect(calls).toEqual([]);
    expect(screen.getByRole('alertdialog', { name: 'Подтверждение стирания' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Да, стереть' }));
    await waitFor(() => expect(onErased).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{
      url: `/api/admin/crm/contacts/${ID}/erase`, method: 'POST', body: { received: '2026-10-22', ticket: '17' },
    }]);
    expect(screen.getByRole('status').textContent)
      .toBe(`Данные клиента в карточке стёрты, основание записано в журнал. ${SOURCES_STAY}`);
  });

  it('без номера — только дата', async () => {
    const calls = stubFetch(200, { success: true, data: { events: 0, tasks: 0 } });
    render(<EraseOnRequest contactId={ID} onErased={() => undefined} />);
    fireEvent.change(dateBox(), { target: { value: '2026-10-22' } });
    fireEvent.click(startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Да, стереть' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ received: '2026-10-22' });
  });

  it('«Отмена» и правка основания снимают подтверждение', () => {
    const calls = stubFetch(200, { success: true });
    render(<EraseOnRequest contactId={ID} onErased={() => undefined} />);
    fireEvent.change(dateBox(), { target: { value: '2026-10-22' } });
    fireEvent.click(startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(startButton());
    fireEvent.change(ticketBox(), { target: { value: '18' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(startButton());
    fireEvent.change(dateBox(), { target: { value: '2026-10-21' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('отказ сервера — его слова, карточка не перечитывается, «стёрты» не сказано', async () => {
    stubFetch(422, { success: false, error: 'Дата обращения — настоящая дата, не позже сегодняшней' });
    const onErased = vi.fn();
    render(<EraseOnRequest contactId={ID} onErased={onErased} />);
    fireEvent.change(dateBox(), { target: { value: '2099-01-01' } });
    fireEvent.click(startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Да, стереть' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('Дата обращения — настоящая дата, не позже сегодняшней'));
    expect(onErased).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('карточка клиента: стирание по обращению — только у администратора', () => {
  const card = (name: string) => ({
    success: true,
    data: {
      id: ID, display_name: name, phone: name === 'Андрей' ? '+79995550202' : null, email: null, tags: [], notes: null,
      origin: 'operator_booking', has_account: false, consent: null, first_seen_at: '2026-09-01T00:00:00Z',
      last_activity_at: '2026-09-01T00:00:00Z', sources: [], events: [],
      partner: { id: 'p1', name: 'Оператор', category: 'operator' },
    },
  });

  it('администратор: блок есть; после стирания карточка перечитывается и список обновляется', async () => {
    const { ContactPanel } = await import('@/components/crm/ContactPanel');
    let erased = false;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') { erased = true; return new Response(JSON.stringify({ success: true }), { status: 200 }); }
      return new Response(JSON.stringify(card(erased ? 'Удалённый пользователь' : 'Андрей')), { status: 200 });
    }));
    const onChanged = vi.fn();
    render(<ContactPanel contactId={ID} mode="admin" onClose={() => undefined} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Андрей' })).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Обращение по персональным данным' })).toBeTruthy();
    fireEvent.change(dateBox(), { target: { value: '2026-10-22' } });
    fireEvent.click(startButton());
    fireEvent.click(screen.getByRole('button', { name: 'Да, стереть' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Удалённый пользователь' })).toBeTruthy());
    expect(calls).toEqual([
      `GET /api/admin/crm/contacts/${ID}`, `POST /api/admin/crm/contacts/${ID}/erase`, `GET /api/admin/crm/contacts/${ID}`,
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('партнёр: блока нет — стирать карточку клиента партнёр не может', async () => {
    const { ContactPanel } = await import('@/components/crm/ContactPanel');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      JSON.stringify(String(url).includes('/tasks') ? { success: true, data: { items: [] } } : card('Андрей')), { status: 200 },
    )));
    render(<ContactPanel contactId={ID} mode="partner" onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Андрей' })).toBeTruthy());
    expect(screen.queryByRole('region', { name: 'Обращение по персональным данным' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Стереть данные клиента' })).toBeNull();
  });
});

describe('карточка со стёртым клиентом не подписывает источник его именем (ревью круга 10, #2327)', () => {
  // После стирания (удаление аккаунта или обращение) заявка в карточке
  // по-прежнему несёт имя из своей строки: «Записан как «Андрей Петров»» под
  // «Удалённый пользователь» вернул бы стёртое имя в ту же карточку.
  const lead = {
    kind: 'lead', id: '00000000-0000-4000-8000-0000000000e1', occurred_at: '2026-09-01T00:00:00Z', title: null,
    date_from: null, date_to: null, status: 'new', people: 2, person_name: 'Андрей Петров',
  };
  const card = (name: string) => ({
    success: true,
    data: {
      id: ID, display_name: name, phone: null, email: null, tags: [], notes: null, origin: 'lead', has_account: false,
      consent: null, first_seen_at: '2026-09-01T00:00:00Z', last_activity_at: '2026-09-01T00:00:00Z',
      sources: [lead], events: [],
    },
  });
  async function show(name: string) {
    const { ContactPanel } = await import('@/components/crm/ContactPanel');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      JSON.stringify(String(url).includes('/tasks') ? { success: true, data: { items: [] } } : card(name)), { status: 200 },
    )));
    render(<ContactPanel contactId={ID} mode="partner" onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('heading', { name })).toBeTruthy());
    return screen.getByRole('region', { name: 'Откуда клиент' });
  }

  it('клиент стёрт — источник без «Записан как»', async () => {
    const sources = await show('Удалённый пользователь');
    expect(sources.textContent).not.toContain('Андрей Петров');
    expect(sources.textContent).not.toContain('Записан как');
  });

  it('клиент не стёрт — источник, записанный под другим именем, подписан им, как раньше', async () => {
    const sources = await show('Андрей');
    expect(sources.textContent).toContain('Записан как «Андрей Петров»');
  });
});
