/**
 * Комиссия платформы — ОДНА реализация записи на оба платёжных вебхука.
 *
 * Повод (аудит дублей 2026-08-03). CloudPayments обрабатывают два живых
 * вебхука, и комиссию писал только один:
 *   • `/api/payments/webhook` — начислял (`operator_commissions`);
 *   • `/api/hub/operator/payments/webhook` — НЕ начислял вовсе.
 * То есть попадёт ли комиссия в учёт, зависело от того, какой URL прописан в
 * кабинете CloudPayments. Ошибка тихая: ни в логах, ни в интерфейсе не видна.
 *
 * Здесь общая часть — поиск оператора, идемпотентная вставка и то, что сбой
 * учёта НЕ роняет обработку платежа (деньги важнее записи о комиссии).
 * СТАВКУ передаёт вызывающий: у двух потоков она разная, и молча сводить их
 * нельзя — это меняло бы суммы (см. `LEGACY_PLATFORM_RATE`).
 */

import { query } from '@/lib/database';

/**
 * Ставка, зашитая в `/api/payments/webhook` с самого начала.
 *
 * ВНИМАНИЕ, расхождение (не исправлено намеренно, решение за владельцем):
 * поток бронирования и hub-вебхук считают комиссию по ДОГОВОРНОЙ ставке
 * оператора — `partners.commission_current` (по умолчанию 15%), и пишут её в
 * `tour_payments`. А этот вебхук пишет в `operator_commissions` фиксированные
 * 12%. Для одной и той же брони две таблицы называют разную комиссию.
 * Трогать существующие суммы без слова владельца нельзя, поэтому старое
 * поведение сохранено дословно.
 */
export const LEGACY_PLATFORM_RATE = 0.12;

interface RecordCommissionParams {
  /** operator_bookings.id */
  bookingId: string | number | bigint;
  /** CloudPayments InvoiceId — ключ идемпотентности (UNIQUE в таблице). */
  invoiceId: string;
  /** Сумма комиссии в рублях. */
  amount: number;
  /** Ставка ДОЛЕЙ единицы (0.12 = 12%): колонка `rate` — NUMERIC(5,4). */
  rate: number;
}

/**
 * Идемпотентно записать комиссию платформы.
 *
 * Идемпотентность — обязательна: CloudPayments повторяет вебхук, пока не
 * получит `code: 0`, и без защиты одна оплата дала бы несколько начислений.
 * Ключ — `operator_commissions.invoice_id` (UNIQUE, миграция 084).
 *
 * Ошибки проглатываются осознанно: платёж уже прошёл, и падение на записи
 * комиссии не должно приводить к повтору всего вебхука.
 */
export async function recordCommission(params: RecordCommissionParams): Promise<void> {
  const { bookingId, invoiceId, amount, rate } = params;
  try {
    if (!invoiceId || !(amount > 0)) return;

    const bookingRes = await query<{ operator_id: string | null }>(
      `SELECT operator_id FROM operator_bookings WHERE id = $1`,
      [bookingId],
    );
    const operatorId = bookingRes.rows[0]?.operator_id;
    if (!operatorId) return;

    await query(
      `INSERT INTO operator_commissions
         (operator_id, booking_id, invoice_id, amount, rate, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
       ON CONFLICT (invoice_id) DO NOTHING`,
      [operatorId, bookingId, invoiceId, amount, rate],
    );
  } catch {
    // Не прерываем платёжный flow при ошибке записи комиссии.
  }
}

/**
 * Записать комиссию по ДОГОВОРНОЙ ставке оператора.
 *
 * Ставку и сумму считает сама база из `partners.commission_current` — той же
 * величины, по которой этот же вебхук строкой выше заполнил `tour_payments`.
 * Иначе две таблицы, записанные одним обработчиком, называли бы разную
 * комиссию по одной броне.
 *
 * `commission_current` хранится в ПРОЦЕНТАХ (15), а `operator_commissions.rate`
 * — в долях (0.15), отсюда деление на 100.
 */
export async function recordCommissionFromBooking(
  bookingId: string | number | bigint,
  invoiceId: string,
): Promise<void> {
  try {
    if (!invoiceId) return;

    await query(
      `INSERT INTO operator_commissions
         (operator_id, booking_id, invoice_id, amount, rate, status, created_at)
       SELECT
         ot.operator_id,
         ob.id,
         $2,
         ROUND(ob.final_price * COALESCE(p.commission_current, 15) / 100, 2),
         ROUND(COALESCE(p.commission_current, 15) / 100.0, 4),
         'pending',
         NOW()
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       JOIN partners p        ON p.id = ot.operator_id
       WHERE ob.id = $1
         AND ob.final_price > 0
       ON CONFLICT (invoice_id) DO NOTHING`,
      [bookingId, invoiceId],
    );
  } catch {
    // Не прерываем платёжный flow при ошибке записи комиссии.
  }
}
