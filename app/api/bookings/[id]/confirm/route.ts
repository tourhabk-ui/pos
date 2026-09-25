/**
 * PATCH /api/bookings/[id]/confirm
 * Подтвердить бронирование: pending -> confirmed
 * Роль: operator, admin
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { confirmBooking } from '@/lib/bookings/booking.service';
import { operatorOwnsBooking } from '@/lib/bookings/operator-owns';
import { ApiResponse } from '@/types';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Auth
    const auth = await verifyAuth(request);
    if (!auth.isAuthenticated || !auth.userId || !auth.role) {
      return NextResponse.json(
        { success: false, error: 'Требуется аутентификация' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    // 2. Проверка роли: только operator или admin
    if (auth.role !== 'operator' && auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'Недостаточно прав. Только оператор или админ может подтвердить бронирование.' } as ApiResponse<null>,
        { status: 403 }
      );
    }

    const { id: bookingId } = await params;

    // 3. Оператор подтверждает только брони своих туров (operator-owns).
    if (auth.role === 'operator') {
      const own = await operatorOwnsBooking(bookingId, auth.userId);
      if (own === 'unknown') {
        return NextResponse.json(
          { success: false, error: 'Не удалось проверить бронирование, попробуйте позже' } as ApiResponse<null>,
          { status: 503 }
        );
      }
      if (own === 'denied') {
        // 404, а не 403: чужая бронь для оператора не существует.
        return NextResponse.json(
          { success: false, error: 'Бронирование не найдено' } as ApiResponse<null>,
          { status: 404 }
        );
      }
    }

    // 4. Бизнес-логика
    const booking = await confirmBooking(bookingId, auth.userId);

    return NextResponse.json({
      success: true,
      data: booking,
      message: 'Бронирование подтверждено',
    } as ApiResponse<typeof booking>);
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
      { success: false, error: 'Ошибка при подтверждении бронирования' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
