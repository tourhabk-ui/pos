/**
 * Кабинет жилья, «Мои объекты» (app/hub/stay/accommodations/_AccommodationsClient):
 *
 * - неизвестное — «не указано», а не «от 0 ₽/ночь» и не «номеров: null»
 *   (formatMoney(null) давал 0 ₽: Number(null) === 0; §4.0, миграция 1006);
 * - владелец видит статус проверки: на проверке / опубликовано /
 *   отклонено с причиной; «Проверено» — только у одобренного;
 * - «Добавить объект» ведёт на отдельную форму, а не в онбординг, который
 *   уводит прошедших его обратно в /hub/stay (тупик до 26.09).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import AccommodationsClient from '@/app/hub/stay/accommodations/_AccommodationsClient';

const BASE = {
  type: 'guesthouse', description: null, short_description: null,
  check_in_time: '14:00:00', check_out_time: '12:00:00',
  price_per_night_to: null, rating: null, review_count: 0,
  is_active: true, is_verified: false, rooms_count: 0, pending_bookings: 0,
};

function listResponse(accommodations: unknown[]) {
  return { ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { accommodations } }) };
}

beforeEach(() => fetchMock.mockReset());

describe('Мои объекты: честные пустоты и статус проверки', () => {
  it('цена и число номеров не указаны → «не указано», без 0 ₽ и null', async () => {
    fetchMock.mockResolvedValue(listResponse([{
      ...BASE, id: 'a1', name: 'База без цены', address: null,
      price_per_night_from: null, total_rooms: null,
      moderation_status: 'pending', moderation_reason: null,
    }]));
    const { container } = render(<AccommodationsClient />);
    await waitFor(() => expect(screen.getByText('База без цены')).toBeTruthy());
    const text = container.textContent ?? '';
    expect(text).toContain('цена за ночь: не указано');
    expect(text).toContain('номеров: не указано');
    expect(text).not.toMatch(/0 ₽/);
    expect(text).not.toContain('null');
    expect(text).toContain('На проверке');
    expect(text).toContain('появится на витрине после проверки');
    expect(text).not.toContain('Проверено');
  });

  it('отклонённый — причина видна; одобренный и проверенный — «Опубликовано» и «Проверено»', async () => {
    fetchMock.mockResolvedValue(listResponse([
      { ...BASE, id: 'a2', name: 'Отклонённый', address: 'Паратунка', price_per_night_from: '3500', total_rooms: 4,
        moderation_status: 'rejected', moderation_reason: 'нет ни одного фото' },
      { ...BASE, id: 'a3', name: 'Одобренный', address: 'Елизово', price_per_night_from: 5000, total_rooms: 2,
        is_verified: true, moderation_status: 'approved', moderation_reason: null },
    ]));
    const { container } = render(<AccommodationsClient />);
    await waitFor(() => expect(screen.getByText('Одобренный')).toBeTruthy());
    const text = container.textContent ?? '';
    expect(text).toContain('Отклонено');
    expect(text).toContain('нет ни одного фото');
    expect(text).toContain('Опубликовано');
    expect(text).toContain('Проверено');
    expect(text).toMatch(/от 3\s?500 ₽\/ночь/);
    expect(text).toContain('номеров: 4');
  });

  it('«Добавить объект» — на отдельную форму, и она существует', async () => {
    fetchMock.mockResolvedValue(listResponse([
      { ...BASE, id: 'a4', name: 'Есть объект', address: null, price_per_night_from: null, total_rooms: null,
        moderation_status: 'approved', moderation_reason: null },
    ]));
    render(<AccommodationsClient />);
    await waitFor(() => expect(screen.getByText('Есть объект')).toBeTruthy());
    const add = screen.getByRole('link', { name: /Добавить объект/ });
    expect(add.getAttribute('href')).toBe('/hub/stay/accommodations/new');

    const src = readFileSync('app/hub/stay/accommodations/_AccommodationsClient.tsx', 'utf-8');
    expect(src).not.toContain('href="/hub/stay/onboarding" className="ds-btn ds-btn-primary">Добавить объект');
    expect(existsSync('app/hub/stay/accommodations/new/page.tsx')).toBe(true);
    const newClient = readFileSync('app/hub/stay/accommodations/new/_NewAccommodationClient.tsx', 'utf-8');
    expect(newClient).toContain('AccommodationCreateForm');
    expect(readFileSync('app/hub/stay/onboarding/_StayOnboardingClient.tsx', 'utf-8')).toContain('AccommodationCreateForm');
  });
});
