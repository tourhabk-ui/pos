// @vitest-environment node
/**
 * Оплата места у перевозчика по QR СБП (миграция 928, «делай по QR» 02.09).
 *
 *   1. Выпуск QR исполняется: чужой заказ — forbidden, неподтверждённый —
 *      not_confirmed, без цены — price_not_set, уже с QR — qr_exists, СБП не
 *      настроен — sbp_unconfigured; сумма берётся из заказа (цена заказа,
 *      иначе цена места × места), а не из запроса.
 *   2. Сверка с банком трёхисходная: null от банка — retry, не оплачено —
 *      not_paid, сумма не сошлась — не подтверждаем, оплачено — settled,
 *      повтор — repeat.
 *   3. Приёмник вебхука зовёт ветку мест ПЕРЕД ответом «не найдено — 200», и
 *      retry уходит 503, как у туров.
 *   4. Записи в таблицу трансферов — только в service.ts (держит carrier-api);
 *      колонки оплаты объявлены миграцией; роут требует вход раньше выпуска.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const svc = {
  getSeatBookingForPayment: vi.fn(),
  findSeatBookingByQr: vi.fn(),
  attachSeatQr: vi.fn(),
  settleSeatPayment: vi.fn(),
};
const bank = {
  createSBPQR: vi.fn(),
  getSBPPaymentStatus: vi.fn(),
  isTochkaConfigured: vi.fn(),
  tochkaMissingEnv: vi.fn(() => ['TOCHKA_JWT_TOKEN']),
};

vi.mock('@/lib/transfers/service', async () => {
  const real = await vi.importActual<typeof import('@/lib/transfers/service')>('@/lib/transfers/service');
  return {
    seatBookingAmount: real.seatBookingAmount,
    getSeatBookingForPayment: (...a: unknown[]) => svc.getSeatBookingForPayment(...a),
    findSeatBookingByQr: (...a: unknown[]) => svc.findSeatBookingByQr(...a),
    attachSeatQr: (...a: unknown[]) => svc.attachSeatQr(...a),
    settleSeatPayment: (...a: unknown[]) => svc.settleSeatPayment(...a),
  };
});
vi.mock('@/lib/payments/tochka', () => ({
  createSBPQR: (...a: unknown[]) => bank.createSBPQR(...a),
  getSBPPaymentStatus: (...a: unknown[]) => bank.getSBPPaymentStatus(...a),
  isTochkaConfigured: () => bank.isTochkaConfigured(),
  tochkaMissingEnv: () => bank.tochkaMissingEnv(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

import { issueSeatQr, settleSeatPaymentByQr, ISSUE_FAILURE_STATUS } from '@/lib/transfers/seat-payment';

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const BASE = {
  id: 'b1', trip_id: 't1', ordered_by_partner_id: null, ordered_by_user_id: 'u1',
  seats: 2, price: null, price_per_seat: '1500.00', status: 'confirmed', decline_reason: null, comment: null,
  payment_status: 'unpaid', tochka_qr_id: null, qr_expires_at: null, paid_at: null, paid_amount: null,
  platform_fee: null, from_text: 'ПК', to_text: 'Горелый', trip_date: '2026-09-20',
};
const QR = { qrId: 'AD10', qrCode: 'png', qrLink: 'https://qr.nspk.ru/AD10', payload: 'sbp', expiresAt: new Date('2026-09-02T13:00:00Z') };

beforeEach(() => {
  for (const m of Object.values(svc)) m.mockReset();
  bank.createSBPQR.mockReset(); bank.getSBPPaymentStatus.mockReset(); bank.isTochkaConfigured.mockReset();
  bank.isTochkaConfigured.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('1. выпуск QR', () => {
  const me = { bookingId: 'b1', userId: 'u1', partnerIds: [] as string[] };

  it('сумма — цена места × места, когда цена заказа не названа; QR привязан к заказу', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE });
    bank.createSBPQR.mockResolvedValue(QR);
    svc.attachSeatQr.mockResolvedValue({ ok: true, value: { id: 'b1' } });
    const r = await issueSeatQr(me);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amount).toBe(3000);
    expect(bank.createSBPQR).toHaveBeenCalledWith(expect.objectContaining({ amountRub: 3000 }));
    expect(svc.attachSeatQr).toHaveBeenCalledWith({ bookingId: 'b1', qrId: 'AD10', expiresAt: QR.expiresAt });
  });

  it('названная цена заказа важнее цены места', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, price: '2500.00' });
    bank.createSBPQR.mockResolvedValue(QR);
    svc.attachSeatQr.mockResolvedValue({ ok: true, value: { id: 'b1' } });
    const r = await issueSeatQr(me);
    expect(r.ok && r.amount).toBe(2500);
  });

  it('чужой заказ — forbidden, банк не зовётся', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, ordered_by_user_id: 'u2' });
    const r = await issueSeatQr(me);
    expect(!r.ok && r.code).toBe('forbidden');
    expect(bank.createSBPQR).not.toHaveBeenCalled();
  });

  it('заказ партнёра оплачивает его пользователь', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, ordered_by_user_id: null, ordered_by_partner_id: 'p9' });
    bank.createSBPQR.mockResolvedValue(QR);
    svc.attachSeatQr.mockResolvedValue({ ok: true, value: { id: 'b1' } });
    const r = await issueSeatQr({ ...me, partnerIds: ['p9'] });
    expect(r.ok).toBe(true);
  });

  it('неподтверждённый, без цены, с QR, оплаченный — отдельные исходы без банка', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, status: 'requested' });
    expect((await issueSeatQr(me)) as { code?: string }).toMatchObject({ ok: false, code: 'not_confirmed' });
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, price_per_seat: null });
    expect((await issueSeatQr(me)) as { code?: string }).toMatchObject({ ok: false, code: 'price_not_set' });
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, tochka_qr_id: 'OLD', payment_status: 'pending' });
    expect((await issueSeatQr(me)) as { code?: string }).toMatchObject({ ok: false, code: 'qr_exists' });
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE, payment_status: 'paid' });
    expect((await issueSeatQr(me)) as { code?: string }).toMatchObject({ ok: false, code: 'already_paid' });
    expect(bank.createSBPQR).not.toHaveBeenCalled();
  });

  it('СБП не настроен — sbp_unconfigured (503), в логе поимённо', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE });
    bank.isTochkaConfigured.mockReturnValue(false);
    const r = await issueSeatQr(me);
    expect(!r.ok && r.code).toBe('sbp_unconfigured');
    expect(ISSUE_FAILURE_STATUS.sbp_unconfigured).toBe(503);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('TOCHKA_JWT_TOKEN');
  });

  it('QR выпущен, но привязать не удалось (гонка) — qr_exists, qrcId в логе', async () => {
    svc.getSeatBookingForPayment.mockResolvedValue({ ...BASE });
    bank.createSBPQR.mockResolvedValue(QR);
    svc.attachSeatQr.mockResolvedValue({ ok: false, code: 'wrong_status', message: 'уже' });
    const r = await issueSeatQr(me);
    expect(!r.ok && r.code).toBe('qr_exists');
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('qr=AD10');
  });
});

describe('2. сверка с банком — три исхода', () => {
  const pending = { ...BASE, payment_status: 'pending', tochka_qr_id: 'AD10' };

  it('qrcId не наш — not_ours, банк не зовётся', async () => {
    svc.findSeatBookingByQr.mockResolvedValue(null);
    expect(await settleSeatPaymentByQr('X')).toEqual({ outcome: 'not_ours' });
    expect(bank.getSBPPaymentStatus).not.toHaveBeenCalled();
  });

  it('банк не ответил — retry, записи нет', async () => {
    svc.findSeatBookingByQr.mockResolvedValue(pending);
    bank.getSBPPaymentStatus.mockResolvedValue(null);
    expect(await settleSeatPaymentByQr('AD10')).toMatchObject({ outcome: 'retry' });
    expect(svc.settleSeatPayment).not.toHaveBeenCalled();
  });

  it('не оплачено — not_paid, записи нет', async () => {
    svc.findSeatBookingByQr.mockResolvedValue(pending);
    bank.getSBPPaymentStatus.mockResolvedValue({ qrId: 'AD10', status: 'pending', raw: 'InProgress' });
    expect(await settleSeatPaymentByQr('AD10')).toMatchObject({ outcome: 'not_paid' });
    expect(svc.settleSeatPayment).not.toHaveBeenCalled();
  });

  it('сумма не сошлась — не подтверждаем', async () => {
    svc.findSeatBookingByQr.mockResolvedValue(pending);
    bank.getSBPPaymentStatus.mockResolvedValue({ qrId: 'AD10', status: 'paid', raw: 'X', amount: 1000 });
    expect(await settleSeatPaymentByQr('AD10')).toMatchObject({ outcome: 'amount_mismatch', expected: 3000, paid: 1000 });
    expect(svc.settleSeatPayment).not.toHaveBeenCalled();
  });

  it('оплачено — settled с суммой банка и запасной ставкой', async () => {
    svc.findSeatBookingByQr.mockResolvedValue(pending);
    bank.getSBPPaymentStatus.mockResolvedValue({ qrId: 'AD10', status: 'paid', raw: 'X', amount: 3000, paidAt: new Date('2026-09-02T12:00:00Z') });
    svc.settleSeatPayment.mockResolvedValue('settled');
    expect(await settleSeatPaymentByQr('AD10')).toEqual({ outcome: 'settled', bookingId: 'b1', amount: 3000 });
    expect(svc.settleSeatPayment).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'b1', paidAmount: 3000, fallbackRatePercent: 10 }));
  });

  it('повторная доставка — repeat, банк не зовётся', async () => {
    svc.findSeatBookingByQr.mockResolvedValue({ ...pending, payment_status: 'paid' });
    expect(await settleSeatPaymentByQr('AD10')).toEqual({ outcome: 'repeat', bookingId: 'b1' });
    expect(bank.getSBPPaymentStatus).not.toHaveBeenCalled();
  });
});

describe('3. приёмник вебхука', () => {
  const src = strip(readFileSync(join(ROOT, 'app/api/payments/tochka/webhook/route.ts'), 'utf8'));

  it('ветка мест стоит до ответа «не найдено — 200», retry уходит 503', () => {
    const at = src.indexOf('settleSeatPaymentByQr(qrId)');
    expect(at).toBeGreaterThan(0);
    const after = src.slice(at, at + 400);
    expect(after).toMatch(/outcome === 'retry'\) return retryLater\(seat\.reason\)/);
    // Раньше здесь был безусловный 200 — с ним оплата места молча терялась бы.
    expect(src.slice(at - 300, at)).not.toMatch(/return NextResponse\.json\(\{ ok: true \}\)/);
  });
});

describe('4. границы', () => {
  it('колонки оплаты объявлены миграцией 928', () => {
    const m = readFileSync(join(ROOT, 'migrations/928_transfer_seat_payment.sql'), 'utf8');
    for (const c of ['tochka_qr_id', 'qr_expires_at', 'payment_status', 'paid_at', 'paid_amount', 'platform_fee']) {
      expect(m).toContain(c);
    }
    expect(m).toMatch(/UNIQUE INDEX[^\n]*idx_transfer_seat_bookings_qr/);
  });

  it('seat-payment.ts не пишет в таблицы трансферов сам', () => {
    const s = strip(readFileSync(join(ROOT, 'lib/transfers/seat-payment.ts'), 'utf8'));
    expect(s).not.toMatch(/UPDATE transfer_|INSERT INTO transfer_/);
    expect(s).not.toMatch(/INSERT INTO operator_commissions/);
  });

  it('роут выпуска QR требует вход раньше выпуска', () => {
    const r = strip(readFileSync(join(ROOT, 'app/api/carrier-trips/bookings/[id]/qr/route.ts'), 'utf8'));
    for (const h of ['POST', 'GET']) {
      const body = r.slice(r.indexOf(`export async function ${h}`));
      const guard = body.indexOf('requireAuth(');
      const work = body.search(/issueSeatQr\(|getSeatBookingForPayment\(/);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(work);
    }
  });
});
