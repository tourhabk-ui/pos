/**
 * tests/unit/booking-form-calendar.test.tsx
 *
 * BookingFormClient — дата заезда теперь выбирается по календарю доступности
 * (/api/tours/[id]/slots), если у тура есть открытые слоты. Контракт:
 * слоты есть → AvailabilityCalendar, клик по дате пишет booking_date;
 * слотов нет / фетч упал → прежний ручной <input type="date"> (календарь
 * операторов опционален — отсутствие строк tour_availability = даты свободны);
 * «Ввести дату вручную» — явный переход на ручной ввод при живом календаре.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import BookingFormClient from '@/components/marketplace/BookingFormClient';

// Будущая дата, чтобы слот был кликабелен независимо от сегодняшнего числа
function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function mockSlots(slots: Array<{ date: string; free_slots: number }> | 'error') {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/slots')) {
      if (slots === 'error') return Promise.reject(new Error('network'));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, slots }),
      });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BookingFormClient — календарь доступности', () => {
  it('тур со слотами → календарь, клик по дате активирует отправку', async () => {
    const slotDate = futureDate(10);
    mockSlots([{ date: slotDate, free_slots: 5 }]);

    render(<BookingFormClient tourId={7} basePrice={5000} tourTitle="Морская прогулка" />);

    await waitFor(() => {
      expect(screen.getByText('Доступные даты')).toBeInTheDocument();
    });
    // Ручного поля даты нет
    expect(document.querySelector('input[name="booking_date"]')).toBeNull();

    // Кнопка отправки заблокирована до выбора даты
    const submit = screen.getByRole('button', { name: /Оставить заявку/ });
    expect(submit).toBeDisabled();

    // Календарь показывает текущий месяц: если слот попал в следующий
    // (запуск теста в конце месяца) — листаем, иначе тест был бы флаки.
    if (new Date(slotDate).getMonth() !== new Date().getMonth()) {
      fireEvent.click(screen.getByLabelText('Следующий месяц'));
    }

    // Клик по доступной дате (день из слота, «N мест» в aria-label)
    const dayNum = Number(slotDate.slice(8, 10));
    const cell = await screen.findByRole('button', { name: `${dayNum} — 5 мест` });
    fireEvent.click(cell);

    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('слотов нет → прежний ручной input type=date', async () => {
    mockSlots([]);

    render(<BookingFormClient tourId={7} basePrice={5000} />);

    await waitFor(() => {
      expect(document.querySelector('input[name="booking_date"]')).not.toBeNull();
    });
    expect(screen.queryByText('Доступные даты')).toBeNull();
  });

  it('фетч слотов упал → ручной input, форма не ломается', async () => {
    mockSlots('error');

    render(<BookingFormClient tourId={7} basePrice={5000} />);

    await waitFor(() => {
      expect(document.querySelector('input[name="booking_date"]')).not.toBeNull();
    });
  });

  it('«Ввести дату вручную» переключает календарь на input', async () => {
    mockSlots([{ date: futureDate(10), free_slots: 5 }]);

    render(<BookingFormClient tourId={7} basePrice={5000} />);

    const toggle = await screen.findByRole('button', { name: 'Ввести дату вручную' });
    fireEvent.click(toggle);

    expect(document.querySelector('input[name="booking_date"]')).not.toBeNull();
    expect(screen.queryByText('Доступные даты')).toBeNull();
  });
});
