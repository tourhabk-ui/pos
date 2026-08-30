/**
 * tests/unit/sbp-qr-payment.test.tsx
 *
 * SbpQrPayment — второй способ оплаты на /booking-success рядом с картой.
 * Раньше QR СБП был доступен только из чата Кузьмича (см. §7 CLAUDE.md);
 * обычный чек-аут показывал только CloudPayments. Контракт компонента:
 *
 *  - успех POST /api/payments/tochka/qr → показывает QR, ссылку на банк и
 *    обратный отсчёт до истечения;
 *  - 503 (СБП не настроен) → «не знаю» не выдаётся за ошибку формы: спокойное
 *    сообщение с советом оплатить картой, без надписи «ошибка»;
 *  - 409 (QR уже выпускался) → не повторяет запрос, объясняет ситуацию и
 *    продолжает опрашивать статус оплаты той же брони;
 *  - опрос GET .../qr?bookingId= каждые 3с — как только paid:true, зовёт onPaid().
 *
 * Таймеры фальшивые (интервал опроса и обратный отсчёт), поэтому вместо
 * waitFor (её внутренний поллинг тоже упирается в фальшивые часы) состояние
 * дожидается явным `advanceTimersByTimeAsync(0)` — он же прогоняет микрозадачи
 * уже отданного fetch-промиса.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import SbpQrPayment from '@/components/marketplace/SbpQrPayment';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });

const QR_RESPONSE = {
  qrCode: 'ZmFrZS1wbmc=',
  qrLink: 'https://qr.nspk.ru/fake',
  payload: 'ST00012|...',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SbpQrPayment', () => {
  it('успешный ответ — показывает QR, ссылку на банк и отсчёт', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve(QR_RESPONSE),
    });

    render(<SbpQrPayment bookingId={4} amount={1500} onPaid={vi.fn()} />);
    await flush();

    expect(screen.getByAltText('QR-код для оплаты через СБП')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть в приложении банка' })).toHaveAttribute(
      'href', QR_RESPONSE.qrLink,
    );
    expect(screen.getByText(/1\s?500 ₽/)).toBeInTheDocument();
    expect(screen.getByText(/QR действителен ещё/)).toBeInTheDocument();
  });

  it('503 — сообщает, что СБП недоступен, без слова «ошибка»', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 503, json: () => Promise.resolve({ error: 'недоступно' }),
    });

    render(<SbpQrPayment bookingId={4} amount={1500} onPaid={vi.fn()} />);
    await flush();

    expect(screen.getByText(/Оплата по СБП сейчас недоступна/)).toBeInTheDocument();
    expect(screen.queryByText(/ошибка/i)).toBeNull();
  });

  it('409 — не повторяет запрос молча, объясняет и продолжает опрос', async () => {
    fetchMock.mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'уже создан' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ paid: false }) });
    });

    render(<SbpQrPayment bookingId={4} amount={1500} onPaid={vi.fn()} />);
    await flush();

    expect(screen.getByText(/уже запрошена ранее/)).toBeInTheDocument();

    // Опрос продолжается — GET вызывается и после 409 на POST
    const getCallsBefore = fetchMock.mock.calls.filter(([, o]) => !o?.method).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    const getCallsAfter = fetchMock.mock.calls.filter(([, o]) => !o?.method).length;
    expect(getCallsAfter).toBeGreaterThan(getCallsBefore);
  });

  it('опрос статуса: paid:true зовёт onPaid()', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(QR_RESPONSE) });
      }
      pollCount += 1;
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ paid: pollCount >= 2 }),
      });
    });
    const onPaid = vi.fn();

    render(<SbpQrPayment bookingId={4} amount={1500} onPaid={onPaid} />);
    await flush();
    expect(screen.getByAltText('QR-код для оплаты через СБП')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onPaid).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onPaid).toHaveBeenCalledTimes(1);
  });
});
