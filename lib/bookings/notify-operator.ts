/**
 * Что происходит с оператором после того, как бронь заведена: синхронизация с
 * его CRM (U-ON) и уведомление в мессенджер.
 *
 * Раньше это жило внутри POST /api/hub/bookings/create, и запрос мест
 * (lib/seat-requests) его не звал: оператор, подтвердивший места кнопкой,
 * получал подтверждённую бронь и НИ ОДНОГО уведомления о ней — ни имени, ни
 * телефона туриста, — а в CRM её не было (обзор ветки 29.09). Копия этого
 * хвоста во второй двери разошлась бы так же, как разошлись копии самой
 * брони (см. шапку lib/bookings/reserve.ts), поэтому хвост один и общий.
 *
 * Не бросает: бронь уже в базе, и упавшее уведомление не отменяет её. Но и не
 * молчит (§4.0): каждый отказ пишется в лог с номером брони, а исход доставки
 * возвращается вызывающему.
 */

import { pool } from '@/lib/db-pool';
import { reachForPartner } from '@/lib/partners/reach';
import { notifyNewBooking, type OperatorDeliveryOutcome } from '@/lib/notifications/operator-booking';
import { createUonRequest } from '@/lib/integrations/uon';

export interface NewBookingForOperator {
  bookingId: number | string;
  operatorId: string;
  tourTitle: string;
  date: string;
  participants: number;
  totalPrice: number;
  touristName: string;
  touristPhone: string;
  touristEmail?: string | null;
  specialRequests?: string | null;
  /** Откуда бронь: 'website', 'seat_request'… — для строки «Источник». */
  via: string;
}

export type OperatorNotifyResult =
  | { state: 'notified'; outcome: OperatorDeliveryOutcome }
  | { state: 'failed'; reason: string };

export async function notifyOperatorOfNewBooking(b: NewBookingForOperator): Promise<OperatorNotifyResult> {
  try {
    // Адрес оператора — через общий модуль: он смотрит ОБЕ колонки
    // (partners.telegram_chat_id и users.telegram_id). Телефон и почта — на
    // случай, когда канала нет вовсе: тогда заявку доносит человек, и ему
    // нужно, чем звонить (issue #1719).
    const [opRow, reach] = await Promise.all([
      pool.query<{ name: string; uon_api_key: string | null; phone: string | null; email: string | null }>(
        `SELECT name, uon_api_key,
                contacts->>'phone' AS phone, contacts->>'email' AS email
           FROM partners WHERE id = $1 LIMIT 1`,
        [b.operatorId],
      ),
      reachForPartner(b.operatorId),
    ]);
    const op = opRow.rows[0];

    // U-ON: у оператора своя CRM; не доехало — заявки в ней нет, и он работает
    // по неполной картине. Не фатально для брони, но и не бесследно.
    if (op?.uon_api_key) {
      try {
        const uonId = await createUonRequest(op.uon_api_key, {
          tour_title:       b.tourTitle,
          booking_date:     b.date,
          participants:     b.participants,
          total_price:      b.totalPrice,
          tourist_name:     b.touristName,
          tourist_phone:    b.touristPhone,
          tourist_email:    b.touristEmail ?? undefined,
          special_requests: b.specialRequests ?? undefined,
          operator_id:      b.operatorId,
          booking_id:       String(b.bookingId),
        });
        if (uonId != null) {
          await pool.query(
            `UPDATE operator_bookings SET uon_request_id = $1, uon_synced_at = NOW() WHERE id = $2`,
            [uonId, b.bookingId],
          );
        }
      } catch (err) {
        console.error('[notify-operator] синк U-ON не прошёл, бронь', String(b.bookingId), err instanceof Error ? err.message : err);
      }
    }

    const outcome = await notifyNewBooking({
      booking_id:                String(b.bookingId),
      tour_title:                b.tourTitle,
      tourist_name:              b.touristName,
      tourist_phone:             b.touristPhone,
      tourist_email:             b.touristEmail ?? undefined,
      booking_date:              b.date,
      participants:              b.participants,
      final_price:               b.totalPrice,
      operator_name:             op?.name ?? 'Оператор',
      operator_telegram_chat_id: reach?.telegramChatId ?? undefined,
      operator_max_chat_id:      reach?.maxChatId ?? undefined,
      operator_phone:            op?.phone ?? null,
      operator_email:            op?.email ?? null,
      via:                       b.via,
    });

    // Адреса нет ни одного — заявка легла в базу и никуда не поехала. Молчать
    // об этом нельзя: Watchdog через 48 часов запишет это как «оператор
    // игнорирует бронь», хотя оператору никто не писал (§4.0).
    if (reach && !reach.reachable) {
      console.error('[notify-operator] у оператора нет ни Telegram, ни MAX — заявка не отправлена, бронь', String(b.bookingId));
    }
    return { state: 'notified', outcome };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'неизвестная ошибка';
    console.error('[notify-operator] уведомление оператору не отправлено, бронь', String(b.bookingId), reason);
    return { state: 'failed', reason };
  }
}
