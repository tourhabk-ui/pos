/**
 * Оплата тура — строка `tour_payments` в HELD. Одна дверь на все приёмники.
 *
 * `tour_payments` — книга денег по туру: из неё оператор видит «Финансы»,
 * по ней часовой релиз выплачивает оператору (`/api/cron/payouts`), из неё
 * отмена считает возврат (`recordRefundDue` берёт ТОЛЬКО HELD). Нет строки —
 * для всех троих оплаты не было, хотя деньги у банка.
 *
 * До 25.09 строку писал один приёмник из трёх, и тот с ошибкой:
 *
 *   - `/api/hub/operator/payments/webhook` писал `ON CONFLICT
 *     (cp_transaction_id)` без предиката, а уникальный индекс на
 *     `cp_transaction_id` ЧАСТИЧНЫЙ (`WHERE cp_transaction_id IS NOT NULL`,
 *     baseline прода). Postgres такой индекс арбитром не выводит и отвечает
 *     42P10 на выполнении — PREPARE при этом проходит, поэтому sql-shape-check
 *     его не видел. Вся транзакция оплаты падала: бронь не подтверждена,
 *     платёж не записан, в логе строка «отказ обработки»;
 *   - `/api/payments/webhook` для брони из кабинета (`handleHubBookingPayment`)
 *     и СБП Точки (`/api/payments/tochka/webhook`) не писали строку вовсе;
 *   - `/api/payments/webhook` для брони с PENDING-строкой ставил
 *     `release_after = NOW() + 36 часов` — выплата оператору через полтора
 *     дня после оплаты, то есть ДО тура, за месяц до него.
 *
 * Срок выплаты один: конец тура + 36 часов (`RELEASE_AFTER_SQL`).
 */
import type { PoolClient } from 'pg';
import { PLATFORM_COMMISSION_PERCENT } from '@/lib/payments/commission';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Когда деньги можно отдать оператору: полночь после последнего дня тура
 * плюс 36 часов. Последний день — `end_date` брони, а у старых броней без
 * него — день выезда плюс число дней тура. Ждёт алиасы `ob`
 * (operator_bookings) и `ot` (operator_tours).
 */
export const RELEASE_AFTER_SQL =
  `(COALESCE(ob.end_date, ob.booking_date + (GREATEST(COALESCE(ot.multi_day_count, 1), 1) - 1))::timestamp
     + INTERVAL '1 day' + INTERVAL '36 hours')`;

export interface HoldInput {
  /** Идентификатор операции у платёжной системы — ключ идемпотентности. */
  transactionId: string;
  invoiceId: string | null;
  method: string;
}

/**
 * `held` — строка теперь HELD (переведена из PENDING или вставлена);
 * `duplicate` — эта операция уже записана (повтор вебхука);
 * `no_booking` — брони нет: записывать не к чему, вызывающий решает сам.
 */
export type HoldOutcome = 'held' | 'duplicate' | 'no_booking';

export async function holdTourPayment(
  client: Queryable,
  bookingId: string | number | bigint,
  input: HoldInput,
): Promise<HoldOutcome> {
  const seen = await client.query(
    `SELECT 1 FROM tour_payments WHERE cp_transaction_id = $1 LIMIT 1`,
    [input.transactionId],
  );
  if (seen.rows.length > 0) return 'duplicate';

  // Бронь с сайта (/api/bookings/tour) заводит PENDING-строку заранее — её и
  // переводим, а не ставим вторую рядом: иначе у брони два платежа, и
  // возврат с выплатой считали бы разное.
  const moved = await client.query(
    `UPDATE tour_payments tp
        SET status = 'HELD',
            cp_transaction_id = $2,
            cp_invoice_id = $3,
            cp_payment_method = $4,
            paid_at = NOW(),
            release_after = ${RELEASE_AFTER_SQL},
            updated_at = NOW()
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ob.id = tp.booking_id
        AND tp.id = (SELECT id FROM tour_payments
                      WHERE booking_id = $1::bigint AND status = 'PENDING'
                      ORDER BY created_at DESC LIMIT 1)
      RETURNING tp.id`,
    [String(bookingId), input.transactionId, input.invoiceId, input.method],
  );
  if (moved.rows.length > 0) return 'held';

  // Ставка — договорная (partners.commission_current), запас тот же, что у
  // всех читателей колонки (lib/payments/commission.ts): net_amount и
  // commission_rate объявлены NOT NULL, и пустая ставка иначе роняла бы
  // всю транзакцию оплаты на 23502.
  const inserted = await client.query(
    `INSERT INTO tour_payments (
       booking_id, operator_id,
       retail_amount, net_amount, commission_amount, commission_rate,
       cp_transaction_id, cp_invoice_id, cp_payment_method,
       status, paid_at, release_after
     )
     SELECT ob.id, ot.operator_id,
            ob.final_price,
            ROUND(ob.final_price * (1 - COALESCE(p.commission_current, $5::numeric) / 100), 2),
            ROUND(ob.final_price * COALESCE(p.commission_current, $5::numeric) / 100, 2),
            COALESCE(p.commission_current, $5::numeric),
            $2, $3, $4,
            'HELD', NOW(), ${RELEASE_AFTER_SQL}
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       JOIN partners p ON p.id = ot.operator_id
      WHERE ob.id = $1::bigint
     ON CONFLICT (cp_transaction_id) WHERE cp_transaction_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [String(bookingId), input.transactionId, input.invoiceId, input.method, PLATFORM_COMMISSION_PERCENT],
  );
  if (inserted.rows.length > 0) return 'held';

  // Ноль строк: либо брони нет, либо параллельный повтор успел вставить ту
  // же операцию (ON CONFLICT). Различаем — это разные исходы.
  const again = await client.query(
    `SELECT 1 FROM tour_payments WHERE cp_transaction_id = $1 LIMIT 1`,
    [input.transactionId],
  );
  return again.rows.length > 0 ? 'duplicate' : 'no_booking';
}
