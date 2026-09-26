/**
 * tests/unit/stay-refund-ui.test.tsx
 *
 * Прозрачность возврата в ЛК туриста (PR 2 цикла возвратов):
 * отменённая бронь с возвратом показывает строку «Возврат: N ₽ (P%)».
 *
 * Правка 26.09 (оплата жилья на месте, решение владельца): сумма к возврату
 * бывает только у старой брони, оплаченной через платформу, и возврат
 * оформляет АДМИНИСТРАЦИЯ ПЛАТФОРМЫ, а не владелец объекта. Прежний текст
 * «ожидает перевода» (от владельца) заменён; сторож держит, что гостю не
 * обещан перевод от владельца.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import StaysClient from '@/app/hub/tourist/stays/_StaysClient';

const CANCELLED_WITH_REFUND = {
  id: 'b1',
  status: 'cancelled',
  paymentStatus: 'paid',
  checkInDate: '2099-08-01',
  checkOutDate: '2099-08-03',
  nights: 2,
  totalPrice: 20000,
  refundAmount: 10000,
  refundPercent: 50,
  accommodationId: 'a1',
  accommodationName: 'Дом у вулкана',
  address: 'ул. Ленина 1',
  cancellationPolicy: 'Отмена за 24 часа — без штрафа',
  roomName: null,
  cancellable: false,
  reviewable: false,
};

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { bookings: [CANCELLED_WITH_REFUND] } }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('StaysClient — строка возврата', () => {
  it('у отменённой оплаченной брони — «к возврату, оформляет администрация», а не «возвращено»', async () => {
    render(<StaysClient />);
    await waitFor(() => expect(screen.getByText('Дом у вулкана')).toBeTruthy());
    // narrow no-break space в ru-RU форматировании → regex по цифрам
    const refund = screen.getByText(/К возврату:\s*10\s*000/);
    expect(refund.textContent).toContain('администрация платформы');
    expect(document.body.textContent).not.toMatch(/владел[а-я]* [а-я ]*перев/i);
  });
});
