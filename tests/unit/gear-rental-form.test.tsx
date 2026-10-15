/**
 * Форма аренды снаряжения для гостя и для вошедшего (аудит 15.10, A13).
 *
 * Дверь проката закрыта за входом (вариант «а»): Edge отвечает гостю 401 до
 * роута. До 15.10 форма показывала на это общий тост «Ошибка создания
 * заявки» — человек не знал, что нужно войти. Теперь, как форма брони
 * жилья, она показывает ссылку на вход. И спрашивает согласие на передачу
 * данных прокату: без галочки кнопка не нажимается, в запрос уходит её
 * состояние.
 *
 * Судится рендером: что видит человек и что уходит в запрос.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/image', () => ({ default: () => null }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GearBookingForm } from '@/components/gear/GearBookingForm';
import { PD_CONSENT_GEAR_TEXT } from '@/lib/legal/pd-consent';

const GEAR = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Палатка MSR Hubba 2',
  category: 'tent',
  pricePerDay: 800,
  availableQuantity: 3,
  condition: 'good',
};

function fillContacts() {
  fireEvent.change(screen.getByLabelText('Имя *'), { target: { value: 'Иван' } });
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'ivan@x.ru' } });
  fireEvent.change(screen.getByLabelText('Телефон *'), { target: { value: '+79990001122' } });
}

function renderForm() {
  const done = vi.fn();
  render(<GearBookingForm gear={GEAR} onBookingComplete={done} onCancel={vi.fn()} />);
  return done;
}

const submitButton = () => screen.getByRole('button', { name: /Забронировать/ });

beforeEach(() => {
  fetchMock.mockReset();
});

describe('согласие на передачу прокату', () => {
  it('галочка называет прокат, без неё кнопка не нажимается', () => {
    renderForm();
    expect(screen.getByText((t) => t.includes(PD_CONSENT_GEAR_TEXT))).toBeTruthy();
    expect(submitButton()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /прокату снаряжения/ }));
    expect(submitButton()).toHaveProperty('disabled', false);
  });

  it('в запрос уходит состояние галочки', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ success: true, data: { rentalId: 'r-1' } }) });
    const done = renderForm();
    fillContacts();
    fireEvent.click(screen.getByRole('checkbox', { name: /прокату снаряжения/ }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(done).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/gear/rentals');
    expect(JSON.parse(String((init as RequestInit).body)).pd_consent).toBe(true);
  });
});

describe('гость', () => {
  it('на 401 форма показывает ссылку на вход, а не общий сбой', async () => {
    fetchMock.mockResolvedValue({ status: 401, ok: false, json: async () => ({ success: false, error: 'Unauthorized' }) });
    const done = renderForm();
    fillContacts();
    fireEvent.click(screen.getByRole('checkbox', { name: /прокату снаряжения/ }));
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/войдите в аккаунт/);
    const link = screen.getByRole('link', { name: 'Войти' });
    expect(link.getAttribute('href')).toBe('/auth/login');
    expect(done).not.toHaveBeenCalled();
  });
});

describe('«сегодня» — по Камчатке', () => {
  it('в 08:00 по Камчатке (20:00 UTC накануне) начало аренды — камчатское сегодня', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T20:00:00Z'));
    try {
      renderForm();
      const start = screen.getByLabelText('Дата начала *') as HTMLInputElement;
      expect(start.value).toBe('2026-10-16');
      expect(start.getAttribute('min')).toBe('2026-10-16');
      expect((screen.getByLabelText('Дата окончания *') as HTMLInputElement).value).toBe('2026-10-17');
    } finally {
      vi.useRealTimers();
    }
  });
});
