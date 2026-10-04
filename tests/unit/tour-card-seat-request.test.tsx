/**
 * Тур без расписания: карточка ведёт через запрос мест, а не через дату
 * вслепую (04.10, владелец: «сплав с карточки мимо запроса мест — направлять
 * через запрос»).
 *
 * Запрос мест — путь планера и Кузьмича (lib/seat-requests): оператор отвечает
 * кнопкой до 2 часов, «Есть места» заводит подтверждённую бронь. С карточки
 * его не звал никто: турист вводил дату руками, и оператор получал бронь на
 * дату, которую он не обещал.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, slots: [] }) })));

import BookingFormClient from '@/components/marketplace/BookingFormClient';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('карточка тура без расписания', () => {
  it('первым путём — запрос мест; окно открывается кнопкой', () => {
    render(<BookingFormClient tourId={5} basePrice={13000} tourTitle="Сплав" askSeatsFirst />);
    expect(screen.getByRole('heading', { name: 'Спросить свободные места' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Оставить заявку/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Спросить места у оператора' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('обычная заявка остаётся одной кнопкой', () => {
    render(<BookingFormClient tourId={5} basePrice={13000} tourTitle="Сплав" askSeatsFirst />);
    fireEvent.click(screen.getByRole('button', { name: 'Оставить обычную заявку' }));
    expect(screen.getByRole('heading', { name: 'Оставить заявку на тур' })).toBeInTheDocument();
  });

  it('тур с расписанием — прежняя форма', () => {
    render(<BookingFormClient tourId={5} basePrice={13000} tourTitle="Рыбалка" />);
    expect(screen.getByRole('heading', { name: 'Оставить заявку на тур' })).toBeInTheDocument();
  });
});

describe('страница тура решает по данным, а «не смог» путь не меняет', () => {
  const PAGE = readFileSync('app/catalog/tours/[id]/page.tsx', 'utf8');
  it('расписания нет И оператор достижим', () => {
    expect(PAGE).toMatch(/askSeatsFirst = dates\?\.recorded === 0 && reach\?\.reachable === true/);
  });
  it('запрос с карточки помечен своим источником', () => {
    expect(readFileSync('app/api/seat-requests/route.ts', 'utf8')).toMatch(/source:\s*d\.source/);
    expect(readFileSync('components/marketplace/BookingFormClient.tsx', 'utf8')).toMatch(/source="tour_card"/);
  });
});
