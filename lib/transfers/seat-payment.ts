/**
 * Оплата места в поездке перевозчика по QR СБП (Точка).
 *
 * Решение владельца 02.09: «делай по QR». Деньги за место идут тем же
 * приёмником, что СБП-оплата туров, — /api/payments/tochka/webhook, — а
 * CloudPayments для трансферов не заводится. Здесь два действия:
 *
 *   issueSeatQr          — турист (или туроператор, заказавший под группу)
 *                          просит QR на подтверждённый заказ; сумма — из
 *                          заказа, не из запроса;
 *   settleSeatPaymentByQr — приёмник вебхука не нашёл qrcId среди броней
 *                          туров и спрашивает здесь. Факт и сумму оплаты
 *                          подтверждает сам банк (getSBPPaymentStatus), тело
 *                          вебхука доказательством не считается — тот же
 *                          принцип, что у туров.
 *
 * Три исхода у сверки с банком (§4.0): оплачено — записываем; не оплачено —
 * повторять нечего; НЕ ВЫЯСНИЛИ (банк молчит, статус не опознан) — просим
 * повтор вебхука и ничего не пишем. Правило, по которому «не выяснили» не
 * равно «не оплачено», записано в lib/payments/tochka.ts и здесь только
 * соблюдается.
 *
 * Записи в таблицу трансферов — только через lib/transfers/service.ts
 * (сторож carrier-api); этот модуль зовёт банк и решает, что записать.
 */
import { createSBPQR, getSBPPaymentStatus, isTochkaConfigured, tochkaMissingEnv } from '@/lib/payments/tochka';
import { PLATFORM_COMMISSION_PERCENT } from '@/lib/payments/commission';
import {
  attachSeatQr,
  findSeatBookingByQr,
  getSeatBookingForPayment,
  seatBookingAmount,
  settleSeatPayment,
} from '@/lib/transfers/service';

/** Сколько живёт QR. Как у туров: час, чтобы успеть открыть банк в поле. */
export const SEAT_QR_TTL_MINUTES = 60;

export type IssueSeatQrFailure =
  | 'not_found'
  | 'forbidden'
  | 'not_confirmed'
  | 'price_not_set'
  | 'already_paid'
  | 'qr_exists'
  | 'sbp_unconfigured'
  | 'bank_failed'
  | 'db_error';

export type IssueSeatQrResult =
  | {
      ok: true;
      amount: number;
      qrCode: string;
      qrLink: string;
      payload: string;
      expiresAt: Date;
    }
  | { ok: false; code: IssueSeatQrFailure; message: string };

export const ISSUE_FAILURE_STATUS: Record<IssueSeatQrFailure, number> = {
  not_found: 404,
  forbidden: 403,
  not_confirmed: 409,
  price_not_set: 409,
  already_paid: 409,
  qr_exists: 409,
  sbp_unconfigured: 503,
  bank_failed: 502,
  db_error: 503,
};

/**
 * Выпустить QR на заказ мест.
 *
 * Заказчик — тот, кто заказывал: пользователь по `ordered_by_user_id` либо
 * один из партнёрских профилей этого пользователя по `ordered_by_partner_id`.
 * Чужой заказ — 403, а не 404: заказ существует, и прятать это незачем.
 */
export async function issueSeatQr(params: {
  bookingId: string;
  userId: string;
  partnerIds: string[];
}): Promise<IssueSeatQrResult> {
  let booking;
  try {
    booking = await getSeatBookingForPayment(params.bookingId);
  } catch (err) {
    console.error('[seat-payment] чтение заказа:', err instanceof Error ? err.message : err);
    return { ok: false, code: 'db_error', message: 'Не удалось прочитать заказ — попробуйте позже' };
  }
  if (!booking) return { ok: false, code: 'not_found', message: 'Заказ мест не найден' };

  const mine =
    (booking.ordered_by_user_id !== null && booking.ordered_by_user_id === params.userId) ||
    (booking.ordered_by_partner_id !== null && params.partnerIds.includes(booking.ordered_by_partner_id));
  if (!mine) return { ok: false, code: 'forbidden', message: 'Это не ваш заказ' };

  if (booking.payment_status === 'paid') {
    return { ok: false, code: 'already_paid', message: 'Заказ уже оплачен' };
  }
  if (booking.status !== 'confirmed') {
    return {
      ok: false,
      code: 'not_confirmed',
      message: `Оплата возможна после подтверждения перевозчиком (сейчас: «${booking.status}»)`,
    };
  }
  if (booking.tochka_qr_id) {
    // Один QR на заказ (миграция 928). Истёкший QR — тоже «уже выпущен»:
    // второй qrcId сделал бы оплату по первому невидимой для приёмника.
    return {
      ok: false,
      code: 'qr_exists',
      message: 'QR для этого заказа уже выпущен. Если он истёк, свяжитесь с перевозчиком',
    };
  }
  const amount = seatBookingAmount(booking);
  if (amount === null) {
    return { ok: false, code: 'price_not_set', message: 'Перевозчик ещё не назвал цену — оплачивать нечего' };
  }

  if (!isTochkaConfigured()) {
    // Туристу — общая фраза; в лог — поимённо, чего не хватает (как у туров).
    console.error('[seat-payment] СБП не настроен, не заданы:', tochkaMissingEnv().join(', '));
    return {
      ok: false,
      code: 'sbp_unconfigured',
      message: 'Оплата через СБП временно недоступна — договоритесь с перевозчиком напрямую',
    };
  }

  const qr = await createSBPQR({
    amountRub: amount,
    description: `TourHab: места ${booking.from_text} — ${booking.to_text} ${booking.trip_date}`,
    ttlMinutes: SEAT_QR_TTL_MINUTES,
  });
  if (!qr) return { ok: false, code: 'bank_failed', message: 'Не удалось создать QR-код оплаты' };

  const attached = await attachSeatQr({ bookingId: booking.id, qrId: qr.qrId, expiresAt: qr.expiresAt });
  if (!attached.ok) {
    // QR у банка уже есть, а к заказу не привязан: оплата по нему до заказа
    // не дойдёт. Это надо видеть в логе с qrcId — по нему банк найдёт платёж.
    console.error('[seat-payment] QR выпущен, но не привязан:', `qr=${qr.qrId}`, `booking=${booking.id}`, attached.message);
    return attached.code === 'wrong_status'
      ? { ok: false, code: 'qr_exists', message: 'QR для этого заказа уже выпущен' }
      : { ok: false, code: 'db_error', message: 'Не удалось сохранить QR — попробуйте позже' };
  }

  return { ok: true, amount, qrCode: qr.qrCode, qrLink: qr.qrLink, payload: qr.payload, expiresAt: qr.expiresAt };
}

export type SettleSeatOutcome =
  /** qrcId не наш: заказа мест с таким QR нет. */
  | { outcome: 'not_ours' }
  /** Не выяснили — просить повтор вебхука. */
  | { outcome: 'retry'; reason: string }
  | { outcome: 'not_paid'; bankStatus: string }
  | { outcome: 'amount_mismatch'; expected: number; paid: number }
  | { outcome: 'settled'; bookingId: string; amount: number }
  /** Повторная доставка: уже записано первым проходом. */
  | { outcome: 'repeat'; bookingId: string }
  /** Заказ ушёл из pending, пока спрашивали банк; факт оплаты — в логе. */
  | { outcome: 'left_pending'; bookingId: string };

export async function settleSeatPaymentByQr(qrId: string): Promise<SettleSeatOutcome> {
  let booking;
  try {
    booking = await findSeatBookingByQr(qrId);
  } catch (err) {
    console.error('[seat-payment] поиск заказа по QR:', err instanceof Error ? err.message : err);
    return { outcome: 'retry', reason: 'seat_lookup_failed' };
  }
  if (!booking) return { outcome: 'not_ours' };
  if (booking.payment_status === 'paid') return { outcome: 'repeat', bookingId: booking.id };

  const status = await getSBPPaymentStatus(qrId);
  if (!status) return { outcome: 'retry', reason: 'bank_status_unavailable' };
  if (status.status !== 'paid') return { outcome: 'not_paid', bankStatus: status.status };

  const expected = seatBookingAmount(booking);
  const paid = status.amount ?? expected;
  if (expected === null || paid === null || Math.abs(paid - expected) > 1) {
    console.error(
      '[seat-payment] сумма оплаты не совпала с заказом — не подтверждаем:',
      `booking=${booking.id}`, `expected=${expected}`, `paid=${paid}`,
    );
    return { outcome: 'amount_mismatch', expected: expected ?? 0, paid: paid ?? 0 };
  }

  const settled = await settleSeatPayment({
    bookingId: booking.id,
    paidAt: status.paidAt ?? new Date(),
    paidAmount: paid,
    fallbackRatePercent: PLATFORM_COMMISSION_PERCENT,
  });
  if (settled === 'settled') return { outcome: 'settled', bookingId: booking.id, amount: paid };
  if (settled === 'already_paid') return { outcome: 'repeat', bookingId: booking.id };
  // Заказ ушёл из pending между поиском и записью. Деньги у банка — молчать
  // нельзя; подтверждать самовольно тоже: решение за человеком.
  console.error('[seat-payment] оплата пришла на заказ вне pending:', `booking=${booking.id}`, `qr=${qrId}`, `state=${settled}`);
  return { outcome: 'left_pending', bookingId: booking.id };
}
