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
 * ── Про возврат денег (#1813; решение владельца 24.09: «как у оператора») ─
 *
 * Сколько вернуть — по условиям тура (`operator_tours.cancellation_free_days`
 * и `cancellation_late_refund_percent`, миграция 1012): до срока — 100%,
 * позже — процент оператора; отменил оператор или условий нет — 100%.
 * Правило одно — `computeTourRefund` (lib/payments/tour-refund.ts); обе
 * ветки зовут его через `recordRefundDue`, который в той же транзакции
 * записывает сумму в `tour_payments.refund_due`.
 *
 * НИ ОДНА ветка не переводит деньги: API CloudPayments/Точки для возврата не
 * подключён (отдельное решение). Ответ называет обязанность платформы, не
 * факт зачисления. Сам возврат администратор оформляет через
 * `POST /api/admin/finance/refunds` — это и есть источник правды о том,
 * вернулись ли деньги на самом деле.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiResponse } from '@/types';
import { verifyAuth } from '@/lib/auth';
import { query, transaction } from '@/lib/database';
import { cancelBooking } from '@/lib/bookings/booking.service';
import { emailService } from '@/lib/notifications/email-service';
import type { AuthRole } from '@/lib/auth';
import { releaseSlotsForCancelledBooking } from '@/lib/payments/slot-counter';
import { recordRefundDue } from '@/lib/payments/record-refund-due';
import { escapeHtml } from '@/lib/text/escape-html';

// Тело необязательно; если есть — причина отмены строкой разумной длины.
const CancelBodySchema = z.object({
  reason: z.string().trim().max(1000, 'Причина длиннее 1000 символов').optional(),
}).passthrough();

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

    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      // Тело необязательно: пустое или не-JSON тело — отмена без причины.
    }
    const parsedBody = CancelBodySchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      return NextResponse.json(
        { success: false, error: parsedBody.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const body = parsedBody.data;

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
          { success: false, error: 'Заявка не найдена' } as ApiResponse<null>,
          { status: 404 }
        );
      }
      const opBooking = ownerCheck.rows[0];
      if (!['new', 'confirmed'].includes(opBooking.booking_status)) {
        return NextResponse.json(
          { success: false, error: 'Заявку нельзя отменить в текущем статусе' } as ApiResponse<null>,
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

        // Сколько вернуть — по условиям тура (решение владельца 24.09: «как у
        // оператора»), от оплаты в HELD; сумма записывается в tour_payments
        // в этой же транзакции. Ветку op- зовёт только сам турист.
        return { refund: await recordRefundDue(client, opId, false) };
      });

      if (cancelled === null) {
        return NextResponse.json(
          { success: false, error: 'Заявку нельзя отменить в текущем статусе' } as ApiResponse<null>,
          { status: 409 }
        );
      }

      // Технического возврата через платёжный API здесь НЕТ (не подключён —
      // отдельное решение); сумма — то, что администратор обязан вернуть
      // вручную и отметить через /api/admin/finance/refunds, а не
      // подтверждение, что деньги уже пришли. Оплаты не было — refund null.
      const refund = cancelled.refund;

      return NextResponse.json({
        success: true,
        message: refund
          ? `Заявка отменена. ${refund.reason} К возврату ${refund.amount.toLocaleString('ru-RU')} ₽, его оформляет администрация платформы.`
          : 'Заявка отменена. Оплаты по этой заявке не было.',
        data: { booking: { id: bookingId }, refund },
      });
    }

    const reason = body.reason || undefined;

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
          { success: false, error: 'Заявка не найдена' } as ApiResponse<null>,
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
          { success: false, error: 'Заявка не найдена' } as ApiResponse<null>,
          { status: 404 }
        );
      }
    } else if (role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'Недостаточно прав для отмены заявки' } as ApiResponse<null>,
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

    // cancelBooking считает возврат по условиям тура от оплаты в HELD и
    // записывает его в tour_payments; неоплаченная бронь получает null, а не
    // письмо «Возврат 15 000 ₽».

    // Уведомляем туриста по email о возврате средств
    const userEmail = booking.tourist?.email;
    if (userEmail) {
      try {
        await emailService.sendEmail({
          to: userEmail,
          subject: `Заявка отменена: ${booking.tour.title}`,
          html: `
            <h2>Ваша заявка отменена</h2>
            <p><strong>Тур:</strong> ${escapeHtml(booking.tour.title)}</p>
            <p><strong>Дата:</strong> ${booking.date.toLocaleDateString('ru-RU')}</p>
            <p><strong>Участники:</strong> ${booking.participants}</p>
            ${reason ? `<p><strong>Причина:</strong> ${escapeHtml(reason)}</p>` : ''}
            ${refund
              ? `<p><strong>Возврат:</strong> ${refund.amount.toLocaleString('ru-RU')} ₽ — ${escapeHtml(refund.reason)} Возврат оформляет администрация платформы.</p>`
              : '<p>Оплаты по этой заявке не было — возвращать нечего.</p>'
            }
            <p>Если у вас есть вопросы — <a href="mailto:info@vedarai.ru">info@vedarai.ru</a></p>
          `,
        });
      } catch (err) {
        // Не прерываем отмену из-за письма, но и не молчим: турист не узнал об отмене (§4.0).
        console.error('[bookings/cancel] письмо об отмене не отправлено:', err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        booking,
        refund,
      },
      message: refund
        ? `Заявка отменена. ${refund.reason} К возврату ${refund.amount.toLocaleString('ru-RU')} ₽, его оформляет администрация платформы.`
        : 'Заявка отменена. Оплаты по этой заявке не было.',
    } as ApiResponse<{ booking: typeof booking; refund: typeof refund }>);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Внутренняя ошибка сервера';

    if (message.includes('не найдено') || message.includes('не найдена')) {
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
      { success: false, error: 'Ошибка при отмене заявки' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}


