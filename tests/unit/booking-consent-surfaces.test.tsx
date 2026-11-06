/**
 * Согласие на ПД на двух поверхностях брони, которые до 06.11 слали имя,
 * телефон и почту без галочки: подборка /p/[code] и карточка брони в виджете
 * Кузьмича.
 *
 * Сервер брони пропускал их по заголовку X-Vedar-Client, который мог прислать
 * кто угодно (docs/agents/LEAD_PLAN.md, направление 1, шаг 1). Теперь аноним
 * без `pd_consent: true` получает 400 (tests/unit/bookings-create-user-id.test.ts),
 * а эти формы гейт держат сами: кнопка выключена без галочки, обработчик без
 * неё запрос не шлёт, в теле уходит состояние галочки.
 *
 * Судит рендер: что видит человек и что уходит на сервер.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

vi.mock('next/image', () => ({
  default: (props: { alt?: string }) => <span role="img" aria-label={props.alt ?? ''} />,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/catalog',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import SelectionClient from '@/app/p/[code]/_SelectionClient';
import { BookingWidget } from '@/components/kuzmich/KuzmichWidget';

const SELECTION = {
  id: 'sel-1',
  title: 'Подборка для вас',
  client_name: null,
  operator_name: 'Оператор',
  expires_at: null,
  tours: [{
    item_id: 'item-1', tour_id: 51, position: 0, note: null,
    title: 'Тестовый тур на вулкан', base_price: 5000, activity_type: 'trekking',
    duration_hours: 8, duration_days: null, difficulty: 'easy', description: 'Описание',
    photo_url: null, hazards: null, mchs_registration_required: false,
  }],
};

type Call = [string, RequestInit | undefined];
let calls: Call[] = [];

function futureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    if (String(url) === '/api/p/CODE') return { ok: true, status: 200, json: async () => SELECTION } as Response;
    if (String(url).includes('/api/hub/bookings/create')) {
      return { ok: true, status: 200, json: async () => ({ id: 77, access_token: 'tok-77' }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createCalls = () => calls.filter(([u]) => u.includes('/api/hub/bookings/create'));

describe('подборка /p/[code]: бронь только с согласием на ПД', () => {
  async function openForm() {
    render(<SelectionClient code="CODE" />);
    fireEvent.click(await screen.findByText('Тестовый тур на вулкан'));
    fireEvent.click(await screen.findByRole('button', { name: /Записаться на тур/ }));
    fireEvent.change(screen.getByLabelText(/Ваше имя/), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByLabelText(/Телефон/), { target: { value: '+79001234567' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ivan@example.com' } });
    fireEvent.change(screen.getByLabelText(/Дата/), { target: { value: futureDate() } });
  }

  it('без галочки кнопка выключена; с ней в теле уходит pd_consent: true', async () => {
    await openForm();
    const submit = screen.getByRole('button', { name: 'Отправить заявку' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const [, init] = createCalls()[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ pd_consent: true, tour_id: 51 });
    expect((init?.headers as Record<string, string>)['X-Vedar-Client']).toBe('selection');
  });

  it('отправка мимо выключенной кнопки без галочки запрос не шлёт и говорит, чего не хватает', async () => {
    await openForm();
    fireEvent.submit(screen.getByRole('button', { name: 'Отправить заявку' }).closest('form') as HTMLFormElement);
    expect(await screen.findByRole('alert')).toHaveTextContent(/согласие на обработку персональных данных/);
    expect(createCalls()).toHaveLength(0);
  });

  it('экран успеха не обещает, что почту не спрашивали: почта у формы обязательна', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    await screen.findByText('Заявка отправлена!');
    expect(screen.queryByText(/Почту эта форма не спрашивает/)).toBeNull();
    expect(screen.getByText(/Сохрани эту ссылку сейчас/)).toBeTruthy();
  });
});

describe('виджет Кузьмича: карточка брони только с согласием на ПД', () => {
  const DATA = { tourId: 51, tourTitle: 'Тестовый тур на вулкан', tourPrice: 5000, tourImage: null, operatorName: 'Оператор' };

  function fill() {
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79001234567' } });
    fireEvent.change(screen.getByPlaceholderText(/^Email/), { target: { value: 'ivan@example.com' } });
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: futureDate() } });
  }

  it('без галочки кнопка выключена; с ней в теле уходит pd_consent: true', async () => {
    const onDone = vi.fn();
    render(<BookingWidget data={DATA} onDone={onDone} />);
    fill();
    const submit = screen.getByRole('button', { name: 'Отправить заявку' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(77));
    const [, init] = createCalls()[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ pd_consent: true, tour_id: 51 });
    expect((init?.headers as Record<string, string>)['X-Vedar-Client']).toBe('kuzmich-widget');
  });

  it('заполненная карточка без галочки запрос не шлёт и говорит, чего не хватает', async () => {
    render(<BookingWidget data={DATA} onDone={vi.fn()} />);
    fill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(await screen.findByRole('alert')).toHaveTextContent(/согласие на обработку персональных данных/);
    expect(createCalls()).toHaveLength(0);
  });

  it('две карточки в одном чате — у каждой своя галочка', () => {
    render(<><BookingWidget data={DATA} onDone={vi.fn()} /><BookingWidget data={DATA} onDone={vi.fn()} /></>);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].id).not.toBe(boxes[1].id);
    fireEvent.click(boxes[0]);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });
});
