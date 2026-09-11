/**
 * POST /api/bookings/[id]/cancel — Отмена бронирования
 *
 * Роли: tourist (свои), operator (свои туры), admin (любые)
 *
 * ── Осторожно: у роута две ветки, и они не равны ──────────────────────────
 *
 * Идентификатор с префиксом `op-` — единственный живой путь: `/api/bookings`
 * отдаёт кабинету туриста именно такие (`op-${id}`), и ветка ниже отменяет
 * бронь прямым запросом к `operator_bookings`. Работает.
 *
 * Непрефиксный идентификатор уходит в `cancelBooking` из
 * `lib/bookings/booking.service.ts`. До 11.09 (#1814) он ЧИТАЛ
 * `operator_bookings`, но ПИСАЛ в `bookings` — другую таблицу, с uuid вместо
 * bigint и без колонок `refund_amount`, `cancelled_at`, `cancelled_by`;
 * запрос отвергался на разборе (42703) и не выполнялся никогда. Починено:
 * пишет в `operator_bookings`, статус отмены один — `cancelled` (колонки под
 * «кто отменил» в таблице нет — это `cancellation_reason`, текст).
 *
 * ── Про возврат денег (обновлено 11.09, решение владельца по #1813) ───────
 *
 * Возврат — 100%, без исключений по срокам (владелец: «пока 100%»). Обе
 * ветки сообщают эту сумму туристу — но НИ ОДНА не переводит деньги: API
 * CloudPayments/Точки для возврата не подключён (отдельное решение). Ответ
 * называет обязанность платформы, не факт зачисления. Сам возврат
 * администратор оформляет через `POST /api/admin/finance/refunds`, отмечая
 * в `tour_payments` кто, когда и почему — это и есть источник правды о том,
 * вернулись ли деньги на самом деле.
 *
 * Раньше здесь стояла докстрока, обещавшая лестницу 100/50/0% внутри
 * неисполнимой ветки, — дефект кода по правилу 10.09, убранный, а не
 * переписанный красивее. Теперь обещания и код совпадают: `refund` в ответе
 * — реальная сумма из `tour_payments.retail_amount` (если бронь была
 * оплачена) с плоским процентом 100, не догадка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@/types';
import { verifyAuth } from '@/lib/auth';
import { query, transaction } from '@/lib/database';
import { cancelBooking } from '@/lib/bookings/booking.service';
import { emailService } from '@/lib/notifications/email-service';
import type { AuthRole } from '@/lib/auth';
import { releaseSlotsForCancelledBooking } from '@/lib/payments/slot-counter';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Auth
    const auth = await verifyAuth(request);
    if (!auth.isAuthenticated || !auth.userId || !auth.role) {
      return NextResponse.json(
        { success: false, error: 'Не авторизован' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const { id: bookingId } = await params;

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // Тело необязательно
    }

    // Operator marketplace bookings have the "op-" prefix
    if (bookingId.startsWith('op-')) {
      const opId = bookingId.slice(3);
      const ownerCheck = await query<{ id: string; booking_status: string }>(
        `SELECT id, booking_status FROM operator_bookings
         WHERE id = $1 AND metadata->>'user_id' = $2`,
        [opId, auth.userId]
      );
      if (ownerCheck.rows.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Бронирование не найдено' } as ApiResponse<null>,
          { status: 404 }
        );
      }
      const opBooking = ownerCheck.rows[0];
      if (!['new', 'confirmed'].includes(opBooking.booking_status)) {
        return NextResponse.json(
          { success: false, error: 'Бронирование нельзя отменить в текущем статусе' } as ApiResponse<null>,
          { status: 409 }
        );
      }

      // Отмена и возврат мест — в ОДНОЙ транзакции, и переход атомарный.
      //
      // Проверка статуса выше и запись ниже раньше шли двумя запросами: две
      // вкладки проходили проверку обе и обе отменяли. Само по себе это было
      // безобидно (повторный UPDATE того же статуса), но с возвратом мест
      // (#1816) двойной переход вычел бы места дважды. Поэтому условие
      // перенесено В САМ UPDATE: строку меняет только первый, второй получает
      // ноль строк и честный 409.
      const cancelled = await transaction(async (client) => {
        const upd = await client.query(
          `UPDATE operator_bookings
              SET booking_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND booking_status IN ('new', 'confirmed')
            RETURNING id`,
          [opId]
        );
        if (upd.rowCount === 0) return null;
        // Места возвращаются в доступность только на настоящем переходе:
        // счётчик до 11.09 умел только расти, и одного цикла «выкупили —
        // отменили» хватало, чтобы дата больше не приняла оплату.
        await releaseSlotsForCancelledBooking(client, opId);

        // Сколько турист заплатил — единственный источник суммы для честного
        // ответа. HELD — единственный статус, на котором возврат ещё не
        // случился и не сгорел в RELEASED; на PENDING деньги ещё не
        // подтверждены платёжной системой.
        const paid = await client.query<{ retail_amount: string }>(
          `SELECT retail_amount FROM tour_payments WHERE booking_id = $1 AND status = 'HELD' LIMIT 1`,
          [opId]
        );
        return { retailAmount: paid.rows[0] ? Number(paid.rows[0].retail_amount) : null };
      });

      if (cancelled === null) {
        return NextResponse.json(
          { success: false, error: 'Бронирование нельзя отменить в текущем статусе' } as ApiResponse<null>,
          { status: 409 }
        );
      }

      // Решение владельца 11.09 (#1813): возврат — 100%. Технического
      // возврата через платёжный API здесь НЕТ (не подключён — отдельное
      // решение); сумма ниже — то, что администратор обязан вернуть вручную
      // и отметить через /api/admin/finance/refunds, а не подтверждение, что
      // деньги уже пришли. Турист не платил вовсе (retailAmount === null,
      // бронь была без оплаты) — тогда возврат неприменим, а не ноль: ноль
      // читался бы как отказ в возврате оплаченного.
      const refund = cancelled.retailAmount !== null
        ? { percent: 100, amount: cancelled.retailAmount, reason: 'Отмена бронирования. Полный возврат (решение владельца 11.09).' }
        : null;

      return NextResponse.json({
        success: true,
        message: refund
          ? `Бронирование отменено. Возврат ${refund.amount.toLocaleString('ru-RU')} ₽ оформляет администрация платформы.`
          : 'Бронирование отменено. Оплаты по этой брони не было.',
        data: { booking: { id: bookingId }, refund },
      });
    }

    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    // 2. Проверка доступа: турист — только свои, оператор — свои туры, админ — всё
    const role = auth.role as AuthRole;

    if (role === 'tourist') {
      // Проверяем владение
      const ownerCheck = await query(
        'SELECT id FROM operator_bookings WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [bookingId, auth.userId]
      );
      if (ownerCheck.rows.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Бронирование не найдено' } as ApiResponse<null>,
          { status: 404 }
        );
      }
    } else if (role === 'operator') {
      // Проверяем что тур принадлежит оператору
      const operatorCheck = await query(
        `SELECT b.id FROM operator_bookings b
         JOIN operator_tours t ON b.operator_tour_id = t.id
         JOIN partners p ON t.operator_id = p.id
         WHERE b.id = $1 AND p.user_id = $2 AND b.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [bookingId, auth.userId]
      );
      if (operatorCheck.rows.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Бронирование не найдено' } as ApiResponse<null>,
          { status: 404 }
        );
      }
    } else if (role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'Недостаточно прав для отмены бронирования' } as ApiResponse<null>,
        { status: 403 }
      );
    }

    // 3. Определяем роль для бизнес-логики
    const cancelRole: 'tourist' | 'operator' | 'admin' =
      role === 'tourist' ? 'tourist' :
      role === 'operator' ? 'operator' : 'admin';

    // 4. Бизнес-логика в транзакции
    const { booking, refund } = await cancelBooking(
      bookingId,
      auth.userId,
      cancelRole,
      reason
    );

    // Уведомляем туриста по email о возврате средств
    const userEmail = booking.tourist?.email;
    if (userEmail) {
      try {
        await emailService.sendEmail({
          to: userEmail,
          subject: `Бронирование отменено: ${booking.tour.title}`,
          html: `
            <h2>Ваше бронирование отменено</h2>
            <p><strong>Тур:</strong> ${booking.tour.title}</p>
            <p><strong>Дата:</strong> ${booking.date.toLocaleDateString('ru-RU')}</p>
            <p><strong>Участники:</strong> ${booking.participants}</p>
            ${reason ? `<p><strong>Причина:</strong> ${reason}</p>` : ''}
            ${refund.amount > 0
              ? `<p><strong>Возврат:</strong> ${refund.amount.toLocaleString('ru-RU')} ₽ — ${refund.reason}</p>`
              : '<p>Возврат средств не предусмотрен условиями отмены.</p>'
            }
            <p>Если у вас есть вопросы — <a href="mailto:support@kamhub.ru">support@kamhub.ru</a></p>
          `,
        });
      } catch {
        // Не прерываем выполнение при ошибке email
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        booking,
        refund,
      },
      message: refund.amount > 0
        ? `Бронирование отменено. ${refund.reason}`
        : 'Бронирование отменено. Возврат средств не предусмотрен.',
    } as ApiResponse<{ booking: typeof booking; refund: typeof refund }>);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Внутренняя ошибка сервера';

    if (message.includes('не найдено')) {
      return NextResponse.json(
        { success: false, error: message } as ApiResponse<null>,
        { status: 404 }
      );
    }
    if (message.includes('Недопустимый переход') || message.includes('Нельзя изменить')) {
      return NextResponse.json(
        { success: false, error: message } as ApiResponse<null>,
        { status: 409 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Ошибка при отмене бронирования' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}


