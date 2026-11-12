/**
 * Форма брони тура: на дату, которую в календаре закрыл Ведар, вместо тупика —
 * вопрос оператору (план «после отказа», этап 6, срез б).
 *
 * До этого среза отказ говорил «спросите оператора», а спросить с формы было
 * нечем. Судится то, что видит и делает человек, — рендером (CLAUDE.md §4):
 *  - кнопка появляется только у отказа с кодом DATE_CLOSED_BY_PLATFORM;
 *  - сказано, что получит оператор и что это не бронь;
 *  - в запрос уходит СОСТОЯНИЕ галочки согласия, та же дата и тот же телефон;
 *  - после отправки — слова сервера и ссылка на страницу заявки;
 *  - правка даты снимает и отказ, и «отправлено»: они были про прежнюю дату.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import BookingFormClient from '@/components/marketplace/BookingFormClient';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

const CLOSED_TEXT = 'Эту дату в календаре закрыл Ведар по описанию тура — оператор её не закрывал и не подтверждал. Выберите другую дату или спросите оператора, ходит ли он в этот день.';
type Reply = { status: number; body: unknown } | 'network';
const reply = (r: Reply) => (r === 'network'
  ? Promise.reject(new TypeError('Failed to fetch'))
  : Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) }));

function mockApi(slotDate: string, create: Reply, ask: Reply = { status: 200, body: { success: true, data: { message: 'Вопрос отправлен оператору: ходит ли он в этот день. Это не бронь — места не закреплены. Ответ оператора появится на странице заявки.', page: 'https://vedarai.ru/request/key_abc', max_link: 'https://max.ru/vedar?start=key_abc' } } }) {
  fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/slots')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, slots: [{ date: slotDate, free_slots: 5 }] }) });
    if (u.includes('/price')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
    if (u.includes('/api/hub/bookings/create')) return reply(create);
    if (u.includes('/api/leads/tour-date-question')) return reply(ask);
    return Promise.reject(new Error('unexpected fetch: ' + u));
  });
}

const dayCell = (iso: string) => screen.findByRole('button', { name: new RegExp(`^${Number(iso.slice(8, 10))} \\S+, свободно мест: \\d+$`) });

async function fillAndSubmit(slotDate: string) {
  fireEvent.click(await dayCell(slotDate));
  fireEvent.change(screen.getByLabelText('Имя *'), { target: { value: 'Пётр Вопрос' } });
  fireEvent.change(screen.getByLabelText('Телефон *'), { target: { value: '8 900 123-45-67' } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'petr@example.com' } });
  fireEvent.change(screen.getByPlaceholderText(/Особые пожелания/), { target: { value: 'Поедем с детьми' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
  fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));
}

const askCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/leads/tour-date-question'));
const askButton = () => screen.queryByRole('button', { name: 'Спросить оператора про эту дату' });

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('форма брони: дату закрыл Ведар — можно спросить оператора', () => {
  it('отказ с кодом DATE_CLOSED_BY_PLATFORM: слова отказа, кнопка вопроса и что получит оператор; совета «повторите» нет', async () => {
    const d = futureDate(10);
    mockApi(d, { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillAndSubmit(d);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Заявка не создана: Эту дату в календаре закрыл Ведар');
    expect(askButton()).not.toBeNull();
    expect(alert).toHaveTextContent('Оператор получит ваши имя и телефон и вопрос, ходит ли он в этот день. Это не бронь: места не закрепляются.');
    // Отказ по существу: «подождите и повторите» тут неправда.
    expect(screen.queryByText(/Подождите минуту/)).toBeNull();
    // Сам вопрос без нажатия не уходит.
    expect(askCalls()).toHaveLength(0);
  });

  it('нажатие отправляет вопрос с той же датой, числом людей, телефоном и состоянием галочки; после — слова сервера и страница заявки', async () => {
    const d = futureDate(10);
    mockApi(d, { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillAndSubmit(d);
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить оператора про эту дату' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Вопрос отправлен оператору: ходит ли он в этот день. Это не бронь — места не закреплены.');
    expect(screen.getByRole('link', { name: 'Открыть страницу заявки' })).toHaveAttribute('href', 'https://vedarai.ru/request/key_abc');
    expect(screen.getByRole('link', { name: 'подключите MAX' })).toHaveAttribute('href', 'https://max.ru/vedar?start=key_abc');
    // Отказ снят: на экране исход, а не две плашки сразу.
    expect(screen.queryByRole('alert')).toBeNull();
    // Со страницы брони человек не уведён: брони нет.
    expect(push).not.toHaveBeenCalled();

    expect(askCalls()).toHaveLength(1);
    const [, init] = askCalls()[0]!;
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      tour_id: 27, date: d, participants: 1, name: 'Пётр Вопрос', phone: '+79001234567',
      comment: 'Поедем с детьми', pd_consent: true,
    });
  });

  it('другой отказ брони (оператор закрыл, мест нет, без кода) — кнопки вопроса нет', async () => {
    const d = futureDate(10);
    for (const body of [
      { created: false, error: 'Оператор закрыл приём заявок на эту дату.', code: 'DATE_BLOCKED' },
      { created: false, error: 'На эту дату осталось мест: 0.', code: 'NO_SEATS' },
      { created: false, error: CLOSED_TEXT },
    ]) {
      mockApi(d, { status: 422, body });
      const view = render(<BookingFormClient tourId={27} basePrice={13000} />);
      await fillAndSubmit(d);
      await screen.findByRole('alert');
      expect(askButton()).toBeNull();
      view.unmount();
    }
  });

  it('правка формы снимает отказ вместе с кнопкой: вопрос не уйдёт про то, чего на экране уже нет', async () => {
    const d = futureDate(10);
    mockApi(d, { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillAndSubmit(d);
    await screen.findByRole('button', { name: 'Спросить оператора про эту дату' });

    fireEvent.change(screen.getByLabelText('Имя *'), { target: { value: 'Пётр Другой' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(askButton()).toBeNull();
  });

  it('галочку сняли после отказа — отказа и кнопки нет, вопрос без согласия не уходит', async () => {
    const d = futureDate(10);
    mockApi(d, { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillAndSubmit(d);
    await screen.findByRole('button', { name: 'Спросить оператора про эту дату' });

    fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
    expect(askButton()).toBeNull();
    expect(askCalls()).toHaveLength(0);
  });

  it('вопрос не отправился (сбой сервера, сеть) — сказано словами, кнопка остаётся; «отправлено» не показано', async () => {
    const d = futureDate(10);
    for (const ask of [
      { status: 503, body: { success: false, error: 'Не удалось проверить дату — вопрос не отправлен. Попробуйте позже или свяжитесь с оператором напрямую.' } },
      'network' as const,
    ]) {
      mockApi(d, { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } }, ask);
      const view = render(<BookingFormClient tourId={27} basePrice={13000} />);
      await fillAndSubmit(d);
      fireEvent.click(await screen.findByRole('button', { name: 'Спросить оператора про эту дату' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/вопрос не отправлен|Не удалось отправить вопрос/));
      expect(screen.queryByRole('status')).toBeNull();
      expect(askButton()).not.toBeNull();
      view.unmount();
    }
  });

  it('дату Ведар уже не закрывает (409) — слова сервера, кнопки вопроса больше нет', async () => {
    const d = futureDate(10);
    mockApi(d,
      { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } },
      { status: 409, body: { success: false, error: 'Эту дату Ведар не закрывал — такой вопрос здесь не отправляется. Нажмите «Оставить заявку» ещё раз: форма скажет, что с датой сейчас.' } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillAndSubmit(d);
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить оператора про эту дату' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Эту дату Ведар не закрывал'));
    expect(askButton()).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('страница заявки не выдалась — ссылок нет, слова сервера на месте', async () => {
    const d = futureDate(10);
    mockApi(d,
      { status: 422, body: { created: false, error: CLOSED_TEXT, code: 'DATE_CLOSED_BY_PLATFORM' } },
      { status: 200, body: { success: true, data: { message: 'Вопрос отправлен оператору: ходит ли он в этот день. Это не бронь — места не закреплены. Страница заявки не выдалась: ответ оператора на сайте не появится — у него есть телефон, который вы оставили.', page: null, max_link: null } } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillAndSubmit(d);
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить оператора про эту дату' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Страница заявки не выдалась');
    expect(screen.queryByRole('link', { name: 'Открыть страницу заявки' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'подключите MAX' })).toBeNull();
  });
});
