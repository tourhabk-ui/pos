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
 * Комиссия платформы по умолчанию — 10% (решение владельца 04.08: «пока нет
 * партнёров делаем 10%»).
 *
 * Это ЗАПАСНОЕ значение. Источник истины — `partners.commission_current`:
 * ставка договорная и у разных операторов может отличаться. Миграция 811
 * привела и дефолты колонок, и текущие значения к 10, поэтому сегодня они
 * совпадают — но код обязан читать базу, а не подменять её константой. Именно
 * так и появилось расхождение, которое здесь закрыто: раньше
 * `/api/payments/webhook` считал захардкоженные 12%, а поток бронирования и
 * hub-вебхук — договорные ~15%, и одна бронь получала разную комиссию в
 * `operator_commissions` и `tour_payments`.
 */
export const PLATFORM_COMMISSION_PERCENT = 10;

/**
 * Идемпотентно записать комиссию платформы по броне.
 *
 * ЕДИНСТВЕННЫЙ способ начислить комиссию — оба платёжных вебхука зовут именно
 * его. Ставку и сумму считает сама база из `partners.commission_current`, то
 * есть из того же источника, по которому hub-вебхук строкой выше заполняет
 * `tour_payments`. Так две таблицы больше не могут назвать разную комиссию по
 * одной броне.
 *
 * Идемпотентность обязательна: CloudPayments повторяет вебхук, пока не получит
 * `code: 0`, и без защиты одна оплата дала бы несколько начислений. Ключ —
 * `operator_commissions.invoice_id` (UNIQUE, миграция 084).
 *
 * Ошибки проглатываются осознанно: платёж уже прошёл, и падение на записи
 * комиссии не должно приводить к повтору всего вебхука.
 *
 * `commission_current` хранится в ПРОЦЕНТАХ (10), а `operator_commissions.rate`
 * — в ДОЛЯХ (0.10), отсюда деление на 100.
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
         ROUND(ob.final_price * COALESCE(p.commission_current, $3) / 100, 2),
         ROUND(COALESCE(p.commission_current, $3) / 100.0, 4),
         'pending',
         NOW()
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       JOIN partners p        ON p.id = ot.operator_id
       WHERE ob.id = $1
         AND ob.final_price > 0
       ON CONFLICT (invoice_id) DO NOTHING`,
      [bookingId, invoiceId, PLATFORM_COMMISSION_PERCENT],
    );
  } catch (err) {
    // Платёжный поток не прерываем — деньги важнее записи о комиссии. Но
    // молчать нельзя (§4.0): именно тишина здесь стоила всех начислений.
    //
    // Таблицы `operator_commissions` на проде не существовало: миграция 084
    // числилась применённой, а её действия в базе не было (перепись 22.08,
    // задача #58). Каждая вставка комиссии падала на «relation does not
    // exist», пустой catch превращал это в «ничего не произошло», и наружу
    // отсутствие комиссий выглядело как отсутствие продаж.
    const e = err as { code?: string; message?: string };
    console.error(
      '[commission] начисление не записано:',
      `booking=${bookingId}`,
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.message ?? String(err),
    );
  }
}
