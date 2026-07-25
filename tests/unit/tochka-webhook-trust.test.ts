/**
 * СБП-вебхук Точки: тело запроса — не доказательство оплаты.
 *
 * Аудит бизнес-процессов 25.07. Обработчик подтверждал бронь по содержимому
 * POST: находил её по `qrcId` и писал booking_status='confirmed' с
 * `paid_amount` прямо из payload. При этом `qrcId` уезжает плательщику вместе
 * с QR — `/api/payments/tochka/qr` возвращает qrLink вида
 * `https://qr.nspk.ru/<qrcId>`. То есть турист мог подтвердить собственную
 * бронь как оплаченную, не заплатив, и сам назначить «оплаченную» сумму.
 *
 * Рубеж — обратный запрос в банк (getSBPPaymentStatus) плюс сверка суммы с
 * final_price брони: ровно так устроен давно работающий CloudPayments-вебхук.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { statusMock, queryMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('@/lib/payments/tochka', () => ({
  getSBPPaymentStatus: (...a: unknown[]) => statusMock(...a),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
}));

import { POST } from '@/app/api/payments/tochka/webhook/route';

const BOOKING = { id: 7, final_price: 12000, tourist_name: 'Турист' };

function request(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const PAYLOAD = {
  event: 'payment.completed',
  qrcId: 'qr-1',
  amount: 1_200_000, // копейки — ровно то, чему раньше верили на слово
  currency: 'RUB',
  transactionDate: '2026-07-25T10:00:00Z',
};

/** Все UPDATE-вызовы, переводящие бронь в confirmed. */
function confirmCalls() {
  return queryMock.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes("booking_status = 'confirmed'"),
  );
}

beforeEach(() => {
  queryMock.mockReset();
  statusMock.mockReset();
  queryMock.mockImplementation((sql: string) =>
    typeof sql === 'string' && sql.trim().startsWith('SELECT')
      ? Promise.resolve({ rows: [BOOKING] })
      : Promise.resolve({ rows: [] }),
  );
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('POST /api/payments/tochka/webhook', () => {
  it('банк говорит «оплачено» — бронь подтверждается', async () => {
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });
    const res = await POST(request(PAYLOAD));
    expect(res.status).toBe(200);
    expect(confirmCalls()).toHaveLength(1);
  });

  it('банк не подтверждает оплату — бронь НЕ подтверждается', async () => {
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'pending' });
    const res = await POST(request(PAYLOAD));
    expect(await res.json()).toMatchObject({ confirmed: false });
    expect(confirmCalls()).toHaveLength(0);
  });

  it('банк недоступен — бронь НЕ подтверждается (лучше повтор вебхука)', async () => {
    statusMock.mockResolvedValue(null);
    await POST(request(PAYLOAD));
    expect(confirmCalls()).toHaveLength(0);
  });

  it('сумма из банка расходится с ценой брони — отказ', async () => {
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 1 });
    await POST(request(PAYLOAD));
    expect(confirmCalls()).toHaveLength(0);
  });

  it('сумма берётся у банка, а не из тела запроса', async () => {
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });
    // Плательщик прислал бы «1 рубль» — записаться должно 12000 от банка.
    await POST(request({ ...PAYLOAD, amount: 100 }));
    const [, params] = confirmCalls()[0];
    expect((params as unknown[])[1]).toBe(12000);
  });

  it('подтверждение идемпотентно: UPDATE только по pending_payment', async () => {
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });
    await POST(request(PAYLOAD));
    const [sql] = confirmCalls()[0];
    expect(sql).toContain("booking_status = 'pending_payment'");
  });

  it('чужое событие — банк даже не опрашивается', async () => {
    await POST(request({ ...PAYLOAD, event: 'payment.created' }));
    expect(statusMock).not.toHaveBeenCalled();
    expect(confirmCalls()).toHaveLength(0);
  });
});
