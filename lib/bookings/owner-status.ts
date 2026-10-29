/**
 * Смена статуса брони тем, кто продаёт тур, — одно правило на две двери:
 * кабинет оператора (`PATCH /api/hub/operator/bookings/[id]`) и раздел
 * «Свои туры» кабинета гида (`PATCH /api/guide/own/bookings/[id]`, 28.10:
 * гид с авторскими турами (1338) продаёт их сам, а подтвердить бронь ему было
 * нечем — кабинет броней открыт только категории `operator`).
 *
 * Кто вправе — решает дверь (оператор: команда и право отмены; гид: владелец
 * своей карточки). Здесь — что происходит с бронью, одинаково для обоих:
 * владение по `operator_tours.operator_id`, разрешённый переход, места при
 * отмене, сумма возврата, лента клиента, письмо, push и Telegram туриста,
 * лояльность при завершении. Вторая копия этого кода разошлась бы с первой
 * поведением — так уже было с кнопкой SOS (#887).
 *
 * Повтор того же статуса (29.10) — не событие: второе нажатие «Подтвердить»
 * (двойной клик, повтор кнопки в чате) не шлёт туристу второе письмо, push и
 * Telegram, не переписывает время и причину отмены, которые турист уже
 * получил, и не начисляет лояльность. Исход говорит `changed: false`, и дверь
 * отвечает «уже подтверждена» — а не «подтверждено», как будто сейчас.
 */
import { query, transaction } from '@/lib/database';
import { loyaltySystem } from '@/lib/loyalty/loyalty-system';
import { sendTouristMail, type TouristMailOutcome } from '@/lib/notifications/tourist-mail';
import { sendPushToUser } from '@/lib/notifications/web-push';
import { releaseSlotsForCancelledBooking } from '@/lib/payments/slot-counter';
import { recordRefundDue } from '@/lib/payments/record-refund-due';
import { ALLOWED_TRANSITIONS, type BookingStatus } from '@/types/booking.types';
import { getPublicBaseUrl } from '@/lib/config';
import { escapeHtml } from '@/lib/text/escape-html';
import { notifyTouristBookingConfirmed, notifyTouristBookingCancelled } from '@/lib/telegram/booking-notify';
import { platformAcceptsPayments } from '@/lib/payments/accepting';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export interface OwnerStatusInput {
  booking_status?: 'new' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  cancellation_reason?: string;
  notes?: string;
}

/**
 * Откуда пришла смена статуса — в ленту клиента (`crm_events.payload.via`):
 * сайт или кнопка в мессенджере. План мини-приложения, §6.7.
 */
export type OwnerStatusVia = 'site' | 'max' | 'telegram';

export type OwnerStatusResult =
  | { kind: 'not_found' }
  | { kind: 'bad_transition'; from: string }
  | {
      kind: 'ok';
      /**
       * Статус брони сменился этим запросом. false — бронь уже была в этом
       * статусе (или статус не передан): туристу ничего не отправлено.
       */
      changed: boolean;
      data: Record<string, unknown>;
      touristNotice: TouristMailOutcome | 'no_email' | null;
    };

/** Что дверь возвращает о брони — одинаково после записи и на повторе без записи. */
const ROW_COLUMNS = `id, booking_status, updated_at, tourist_email, tourist_name, final_price,
                 access_token::text AS access_token, user_id::text AS user_id,
                 booking_date::text AS booking_date, participants,
                 (SELECT title FROM operator_tours WHERE id = operator_tour_id) AS tour_title`;

/**
 * Меняет бронь тура, принадлежащего `ownerPartnerId`. Владение, чтение
 * прежнего статуса и запись — в ОДНОЙ транзакции под блокировкой строки
 * (FOR UPDATE): два параллельных запроса не начислят лояльность дважды.
 */
export async function changeOwnerBookingStatus(args: {
  ownerPartnerId: string;
  actorUserId: string;
  bookingId: string;
  input: OwnerStatusInput;
  via: OwnerStatusVia;
}): Promise<OwnerStatusResult> {
  const { ownerPartnerId, actorUserId, input, via } = args;
  const id = args.bookingId;

  const txResult = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT b.id, b.booking_status FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       WHERE b.id = $1 AND t.operator_id = $2 AND b.deleted_at IS NULL
       FOR UPDATE OF b`,
      [BigInt(id), ownerPartnerId]
    );
    if (locked.rows.length === 0) {
      return { row: undefined, changed: false, badTransition: null, refund: null, prevStatus: null as string | null };
    }
    const prevStatus = (locked.rows[0] as { booking_status: string }).booking_status;

    // Переход — только разрешённый (ALLOWED_TRANSITIONS, как у сервиса
    // броней). До 25.09 любой статус ставился из любого: «отменена» →
    // «подтверждена» возвращала бронь, чьи места уже отданы другим.
    if (input.booking_status && input.booking_status !== prevStatus) {
      const allowed = (ALLOWED_TRANSITIONS as Record<string, readonly BookingStatus[]>)[prevStatus] ?? [];
      if (!allowed.includes(input.booking_status as BookingStatus)) {
        return { row: undefined, changed: false, badTransition: prevStatus, refund: null, prevStatus: null as string | null };
      }
    }
    // Тот же статус — повтор: ни статус, ни время и причина отмены не
    // переписываются (турист их уже получил), уведомления ниже не уходят.
    const changed = input.booking_status !== undefined && input.booking_status !== prevStatus;

    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (changed) {
      sets.push(`booking_status = $${idx++}`);
      values.push(input.booking_status);
      if (input.booking_status === 'cancelled') {
        sets.push(`cancelled_at = NOW()`);
      }
    }
    if (input.cancellation_reason !== undefined && (changed || input.booking_status === undefined)) {
      sets.push(`cancellation_reason = $${idx++}`);
      values.push(input.cancellation_reason);
    }
    if (input.notes !== undefined) {
      sets.push(`notes = $${idx++}`);
      values.push(input.notes);
    }

    values.push(BigInt(id));

    // Менять нечего (повтор статуса без заметки) — строка читается, а не
    // переписывается: updated_at остаётся временем настоящей смены.
    const result = sets.length > 1
      ? await client.query(
        `UPDATE operator_bookings SET ${sets.join(', ')}
         WHERE id = $${idx}
         RETURNING ${ROW_COLUMNS}`,
        values,
      )
      : await client.query(`SELECT ${ROW_COLUMNS} FROM operator_bookings WHERE id = $1`, [BigInt(id)]);

    // Места возвращаются в доступность — В ТОЙ ЖЕ транзакции и только на
    // ПЕРЕХОДЕ в отменённое. Счётчик наполняют платёжные вебхуки и до
    // 11.09 не уменьшал никто: одного цикла «дату выкупили — отменили»
    // хватало, чтобы дата больше не приняла оплату (#1816, CHECK
    // booked_valid роняет транзакцию оплаты). Условие на prevStatus —
    // чтобы повторная отмена не вычла дважды.
    let refund: Awaited<ReturnType<typeof recordRefundDue>> = null;
    if (input.booking_status === 'cancelled' && prevStatus !== 'cancelled') {
      await releaseSlotsForCancelledBooking(client, BigInt(id));
      // Отмена продавцом тура — 100% (lib/payments/tour-refund). Сумма
      // записывается в tour_payments.refund_due в этой же транзакции, как
      // у остальных дверей отмены.
      refund = await recordRefundDue(client, id, true);
    }

    return { row: result.rows[0], changed, badTransition: null, refund, prevStatus: prevStatus as string | null };
  });

  if (txResult.badTransition) return { kind: 'bad_transition', from: txResult.badTransition };
  if (!txResult.row) return { kind: 'not_found' };

  const row = txResult.row as {
    tourist_email?: string; tourist_name?: string;
    final_price?: string; tour_title?: string; booking_status?: string;
    access_token?: string | null; user_id?: string | null;
    booking_date?: string | null; participants?: number | null;
  };
  // Страница брони — там же кнопка оплаты после подтверждения (решение
  // 24.09). Ключ брони в ссылке, как в письме о создании заявки.
  const bookingUrl = row.access_token
    ? `${getPublicBaseUrl()}/booking-success/${id}?t=${encodeURIComponent(row.access_token)}`
    : `${getPublicBaseUrl()}/hub/tourist/bookings`;
  const refund = txResult.refund;
  const changed = txResult.changed;

  // Повтор того же статуса: туристу уже всё ушло при первой смене, лояльность
  // начислена тогда же. Исход называет повтор — дверь скажет «уже».
  if (!changed) {
    return { kind: 'ok', changed: false, data: txResult.row as Record<string, unknown>, touristNotice: null };
  }

  // Лента клиента (CRM #2325): кабинет меняет статус мимо booking.service.
  if (input.booking_status && txResult.prevStatus) {
    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'operator_booking', sourceId: id,
      actorKind: 'partner_user', actorUserId,
      title: statusChangeTitle('operator_booking', txResult.prevStatus, input.booking_status),
      payload: { from: txResult.prevStatus, to: input.booking_status, reason: input.cancellation_reason ?? null, via },
    });
  }

  // Письмо туристу о подтверждении или отмене. Для гостя это ЕДИНСТВЕННЫЙ
  // путь к оплате (lib/bookings/guest-contact), поэтому исход отправки
  // возвращается кабинету: «не ушло» продавец должен увидеть, а не узнать
  // от туриста (lib/notifications/tourist-mail).
  let touristNotice: TouristMailOutcome | 'no_email' | null = null;
  if (input.booking_status && ['confirmed', 'cancelled'].includes(input.booking_status) && !row.tourist_email) {
    touristNotice = 'no_email';
  }
  if (row.tourist_email && input.booking_status && ['confirmed', 'cancelled'].includes(input.booking_status)) {
    const isConfirmed = input.booking_status === 'confirmed';
    const subject = isConfirmed
      ? `Бронирование подтверждено: ${row.tour_title ?? 'тур'}`
      : `Бронирование отменено: ${row.tour_title ?? 'тур'}`;
    const html = isConfirmed
      ? `<h2>Ваше бронирование подтверждено!</h2>
         <p><strong>Тур:</strong> ${escapeHtml(row.tour_title ?? '')}</p>
         <p><strong>Стоимость:</strong> ${parseFloat(row.final_price ?? '0').toLocaleString('ru-RU')} ₽</p>
         ${platformAcceptsPayments()
           ? `<p>Теперь бронь можно оплатить: <a href="${bookingUrl}">открыть бронь и перейти к оплате</a>.</p>`
           : `<p>Оплата — напрямую оператору: Ведар платежи не принимает, реквизиты сообщит оператор. <a href="${bookingUrl}">Открыть бронь</a>.</p>`}`
      : `<h2>Бронирование отменено</h2>
         <p><strong>Тур:</strong> ${escapeHtml(row.tour_title ?? '')}</p>
         ${input.cancellation_reason ? `<p><strong>Причина:</strong> ${escapeHtml(input.cancellation_reason)}</p>` : ''}
         ${refund ? `<p><strong>Возврат:</strong> ${refund.amount.toLocaleString('ru-RU')} ₽ — ${refund.reason} Возврат оформляет администрация платформы.</p>` : ''}
         <p>Свяжитесь с оператором или выберите другой тур на <a href="${getPublicBaseUrl()}/catalog">платформе</a>.</p>`;
    touristNotice = await sendTouristMail('operator-booking-status', id, { to: row.tourist_email, subject, html });

    // Push notification to tourist
    const touristRes = await query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [row.tourist_email],
    );
    if (touristRes.rows[0]) {
      sendPushToUser(touristRes.rows[0].id, {
        title: isConfirmed ? 'Бронирование подтверждено' : 'Бронирование отменено',
        body: isConfirmed
          ? `${row.tour_title ?? 'Тур'} — оператор подтвердил. Проверьте детали.`
          : `${row.tour_title ?? 'Тур'} — бронирование отменено.`,
        url: isConfirmed ? bookingUrl.replace(getPublicBaseUrl(), '') : '/hub/tourist/bookings',
      }, {
        // Следствие действия продавца, не рассылка. Даже если push
        // подавлен настройкой, письмо выше уходит безусловно — человек
        // узнает об отмене брони в любом случае.
        kind: 'transactional',
        type: isConfirmed ? 'booking_confirmed' : 'booking_cancelled',
      }).catch((e) => logSwallowedFailure('owner-status', 'push туристу', e));
    }
  }

  // Telegram туриста — кабинет живая дверь подтверждения: турист с
  // привязанным Telegram узнаёт о ней тем же текстом, что и раньше.
  if (row.user_id && input.booking_status === 'confirmed') {
    notifyTouristBookingConfirmed(row.user_id, {
      id,
      tourTitle: row.tour_title ?? 'Тур',
      date: new Date(`${row.booking_date ?? ''}T00:00:00`),
      participants: Number(row.participants ?? 1),
      url: bookingUrl,
    });
  } else if (row.user_id && input.booking_status === 'cancelled') {
    notifyTouristBookingCancelled(row.user_id, {
      id,
      tourTitle: row.tour_title ?? 'Тур',
      cancelledBy: 'operator',
      refundPercent: refund?.percent ?? 0,
      refundAmount: refund?.amount ?? 0,
      refundReason: refund?.reason ?? 'Оплаты по этой брони не было — возвращать нечего.',
    });
  }

  // Лояльность при завершении — только один раз: строка, уже бывшая
  // 'completed' до этого запроса (гонка/повтор), вернулась выше с changed:false.
  if (
    input.booking_status === 'completed' &&
    row.tourist_email &&
    row.final_price
  ) {
    const userResult = await query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [row.tourist_email]
    );
    if (userResult.rows[0]) {
      const uid = userResult.rows[0].id;
      const price = parseFloat(row.final_price);
      await query('UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2', [price, uid]);
      loyaltySystem.earnPoints(uid, id, price, 'booking')
        .catch((e) => logSwallowedFailure('owner-status', 'баллы за бронь', e));
      loyaltySystem.earnActivityPoints(uid, 'first_booking', id)
        .catch((e) => logSwallowedFailure('owner-status', 'баллы за первую бронь', e));
      loyaltySystem.completeReferral(uid)
        .catch((e) => logSwallowedFailure('owner-status', 'реферал', e));
    }
  }

  return { kind: 'ok', changed: true, data: txResult.row as Record<string, unknown>, touristNotice };
}
