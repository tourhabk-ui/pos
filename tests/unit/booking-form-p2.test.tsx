/**
 * tests/unit/booking-form-p2.test.tsx
 *
 * Форма брони тура — гарантии пакета П2 (аудит интерфейса 24.09).
 *
 * Каждая гарантия здесь — след конкретного дефекта, найденного на снимках:
 *
 *  - сообщение об отказе было НЕЧИТАЕМО: `bg-[var(--danger)] bg-opacity-10`
 *    в Tailwind 3 даёт сплошной красный фон, текст того же цвета — человек
 *    видел красный прямоугольник вместо «Проверьте телефон»;
 *  - календарь и форма держали дату РАЗДЕЛЬНО: повторный тап снимал выделение,
 *    а форма молча отправляла прежний день; листание месяца прятало выбор;
 *  - форма была карточкой внутри карточки aside — итог «52 000 / ₽» и кнопка
 *    «Оставить / заявку» рвались на две строки;
 *  - подписи полей не были связаны с полями, email был обязательным при
 *    `optional()` на сервере (решение владельца 24.09: необязательный);
 *  - совет «подождите и повторите» висел под кнопкой всегда, а не при отказе.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import BookingFormClient from '@/components/marketplace/BookingFormClient';
import { monthTitle } from '@/components/routes/AvailabilityCalendar';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
/** Только код, без комментариев: объяснения прежних ошибок не должны ловиться. */
const code = (f: string) => read(f).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const scrollSpy = vi.fn();

type CreateReply = { status: number; body: unknown } | 'network' | 'pending';

function mockApi(slots: Array<{ date: string; free_slots: number }>, create: CreateReply = { status: 200, body: { booking_id: 1, access_token: 't' } }) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/slots')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, slots }) });
    }
    if (String(url).includes('/api/hub/bookings/create')) {
      if (create === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      if (create === 'pending') return new Promise(() => {});
      return Promise.resolve({ ok: create.status < 400, status: create.status, json: () => Promise.resolve(create.body) });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = scrollSpy;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const dayCell = (iso: string) => {
  const day = Number(iso.slice(8, 10));
  return screen.findByRole('button', { name: new RegExp(`^${day} \\S+, свободно мест: \\d+$`) });
};

async function fillValid(slotDate: string, phone = '+7 900 123 45 67') {
  fireEvent.click(await dayCell(slotDate));
  fireEvent.change(screen.getByLabelText('Имя *'), { target: { value: 'Иван Проверка' } });
  fireEvent.change(screen.getByLabelText('Телефон *'), { target: { value: phone } });
  fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
}

describe('П2: отказ читаем и указывает на поле', () => {
  it('телефон «123» — бледная подложка color-mix, role=alert, поле подсвечено, прокрутка к сообщению', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }]);
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillValid(d, '123');
    fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Проверьте телефон/);
    // Не сплошной --danger: подложка — примесь 10%, текст — --danger.
    expect(alert.getAttribute('style') ?? '').toMatch(/color-mix\(in srgb, var\(--danger\) 10%/);
    expect(alert.className).not.toMatch(/bg-\[var\(--danger\)\]/);
    expect(alert.className).not.toMatch(/bg-opacity/);
    expect(screen.getByLabelText('Телефон *')).toHaveAttribute('aria-invalid', 'true');
    expect(scrollSpy).toHaveBeenCalled();
    // Отказ по вводу — совет «повторите» тут неуместен.
    expect(screen.queryByText(/Подождите минуту/)).toBeNull();
    // Запрос не ушёл.
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/create'))).toBe(false);

    // Правка поля снимает прежний отказ.
    fireEvent.change(screen.getByLabelText('Телефон *'), { target: { value: '+7 900' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('сервер назвал поле — подсвечено оно, совета «повторите» нет', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }], { status: 400, body: { error: 'Имя: минимум 2 символа', field: 'tourist_name' } });
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillValid(d);
    fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Имя: минимум 2 символа');
    expect(screen.getByLabelText('Имя *')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Телефон *')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/Подождите минуту/)).toBeNull();
  });

  it('сеть упала — русский текст и совет подождать; до отказа совета под кнопкой нет', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }], 'network');
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillValid(d);
    expect(screen.queryByText(/попробуйте снова/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Не удалось отправить заявку/);
    expect(alert).toHaveTextContent(/Подождите минуту и попробуйте снова/);
    // §4.0: отказ не глушится.
    expect(console.error).toHaveBeenCalled();
  });

  it('при отправке кнопка говорит «Отправляем…», а не превращается в пустой спиннер', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }], 'pending');
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    await fillValid(d);
    fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));
    expect(await screen.findByRole('button', { name: /Отправляем…/ })).toBeDisabled();
  });
});

describe('П2: календарь управляется датой формы', () => {
  it('повторный тап снимает дату и в форме — кнопка снова ждёт дату', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }]);
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    const cell = await dayCell(d);
    fireEvent.click(cell);
    expect(cell).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Сначала выберите дату заезда/)).toBeNull();

    fireEvent.click(cell);
    expect(cell).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/Сначала выберите дату заезда/)).toBeInTheDocument();
    expect(screen.queryByText(/^Выбрано:/)).toBeNull();
  });

  it('при листании месяцев строка «Выбрано» остаётся, дата в форме цела', async () => {
    const d1 = futureDate(10);
    const d2 = futureDate(45); // через 35 дней — всегда другой месяц
    mockApi([{ date: d1, free_slots: 5 }, { date: d2, free_slots: 5 }]);
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    fireEvent.click(await dayCell(d1));
    const line = () => screen.getByText(/^Выбрано:/);
    const before = line().textContent;

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Следующий месяц' })); });
    expect(line().textContent).toBe(before);
    expect(screen.queryByText(/Сначала выберите дату заезда/)).toBeNull();
  });

  it('предвыбранная дата (?date=) — календарь открывается на её месяце и показывает её', async () => {
    const d1 = futureDate(10);
    const d2 = futureDate(45);
    mockApi([{ date: d1, free_slots: 5 }, { date: d2, free_slots: 5 }]);
    window.history.replaceState(null, '', `/?date=${d2}`);
    try {
      render(<BookingFormClient tourId={27} basePrice={13000} />);
      const cell = await dayCell(d2);
      expect(cell).toHaveAttribute('aria-pressed', 'true');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('заголовок месяца — «Сентябрь 2026», без «Г.» и без capitalize', () => {
    expect(monthTitle(new Date(2026, 8, 1))).toBe('Сентябрь 2026');
    expect(code('components/routes/AvailabilityCalendar.tsx')).not.toMatch(/\bcapitalize\b/);
  });
});

describe('П2: поля, подписи, итог', () => {
  it('подписи связаны с полями; автозаполнение имени, телефона и почты', async () => {
    mockApi([]);
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    expect(screen.getByLabelText('Имя *')).toHaveAttribute('autocomplete', 'name');
    const tel = screen.getByLabelText('Телефон *');
    expect(tel).toHaveAttribute('autocomplete', 'tel');
    expect(tel).toHaveAttribute('inputmode', 'tel');
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText(/Количество участников/).tagName).toBe('SELECT');
    expect(screen.getByLabelText('Пожелания оператору').tagName).toBe('TEXTAREA');
    // Ручной ввод даты (слотов нет) связан с подписью «Дата заезда».
    await waitFor(() => expect(screen.getByLabelText(/Дата заезда/)).toHaveAttribute('type', 'date'));
  });

  it('email необязателен и пустым в запрос не уходит (решение владельца 24.09)', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }]);
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    const email = screen.getByLabelText(/Email/);
    expect(email).not.toBeRequired();
    expect(screen.getByText(/пришлём ссылку на заявку/i)).toBeInTheDocument();

    await fillValid(d);
    fireEvent.click(screen.getByRole('button', { name: /Оставить заявку/ }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/create'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect('tourist_email' in body).toBe(false);
    expect(body.pd_consent).toBe(true);
  });

  it('итог: сумма одной строкой над кнопкой во всю ширину; форма не вторая карточка', async () => {
    const d = futureDate(10);
    mockApi([{ date: d, free_slots: 5 }]);
    const { container } = render(<BookingFormClient tourId={27} basePrice={13000} />);
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form.className).not.toMatch(/ds-card/);
    expect(form.className).not.toMatch(/\bp-6\b/);

    fireEvent.click(await dayCell(d));
    fireEvent.change(screen.getByLabelText(/Количество участников/), { target: { value: '4' } });
    // Разделители — неразрывные: «52 000 ₽» не может порваться на «52 000 / ₽».
    const total = screen.getByText((_, el) => el?.tagName === 'P' && /^52\s000\u00a0₽$/.test(el.textContent ?? ''));
    expect(total.className).toMatch(/whitespace-nowrap/);
    const btn = screen.getByRole('button', { name: /Оставить заявку/ });
    expect(btn.className).toMatch(/\bw-full\b/);
    expect(btn.className).toMatch(/whitespace-nowrap/);
    // Сумма и кнопка — не в одной строке flex: сумма СТОИТ ПЕРЕД кнопкой в колонке.
    expect(total.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(btn.parentElement?.className ?? '').not.toMatch(/justify-between/);
  });

  it('подсказка выключенной кнопки — основной текст с иконкой --warning, а не жёлтый текст', () => {
    const src = code('components/marketplace/BookingFormClient.tsx');
    expect(src).not.toMatch(/id="booking-submit-hint" className="[^"]*text-\[var\(--warning\)\]/);
    expect(src).toMatch(/id="booking-submit-hint" className="[^"]*text-\[var\(--text-primary\)\]/);
    // Вспомогательный текст формы — не --text-muted (он для плейсхолдеров).
    expect(src).not.toMatch(/text-\[var\(--text-muted\)\]/);
  });

  it('«Ввести дату вручную» — тач-цель 44px', async () => {
    mockApi([{ date: futureDate(10), free_slots: 5 }]);
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    const toggle = await screen.findByRole('button', { name: 'Ввести дату вручную' });
    expect(toggle.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('П2: галочка согласия', () => {
  const src = read('components/legal/PdConsentCheckbox.tsx');
  it('текст читаемый (--text-secondary), метка — зона 44px', () => {
    const c = code('components/legal/PdConsentCheckbox.tsx');
    expect(c).toMatch(/min-h-\[44px\]/);
    expect(c).toMatch(/text-\[var\(--text-secondary\)\]/);
    expect(c).not.toMatch(/text-\[var\(--text-muted\)\]/);
  });
  it('докстрока называет оба законных гейта: disabled и проверку в submit (на это опирается П4)', () => {
    expect(src).toMatch(/`disabled`/);
    expect(src).toMatch(/проверка в обработчике submit/);
  });
});
