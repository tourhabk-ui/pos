/**
 * Bookings Payments Refund API
 * POST /api/bookings/payments/[id]/refund - Process refund
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { paymentService } from '@/lib/services'
import { getBookingForUser, getBookingById } from '@/lib/bookings/booking.service'
import { authenticateUser, authorizeRole } from '@/lib/auth'

// Валидация тела возврата (§4). Ключевое — refundAmount: сырым он уходил в
// paymentService.refund, и отрицательная/абсурдная сумма прошла бы как есть.
// Опционален (частичный возврат); при отсутствии сервис берёт полную сумму.
const RefundSchema = z.object({
  reason: z.string().min(1, 'reason is required').max(500),
  refundAmount: z.number().positive().finite().optional(),
  description: z.string().max(2000).optional(),
})

/**
 * POST /api/bookings/payments/[id]/refund
 * Process refund for a payment (admin or booking owner)
 * Body: { reason, refundAmount }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await authenticateUser(request)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    let body: unknown
    try { body = await request.json() }
    catch { return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 }) }

    const parsed = RefundSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }, { status: 400 })
    }
    const { reason, refundAmount, description } = parsed.data

    const payment = await paymentService.getTransaction(id)

    if (!payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    if (!payment.bookingId) {
      return NextResponse.json({ error: 'Payment has no booking reference' }, { status: 400 })
    }

    // Проверяем права: либо владелец брони, либо admin
    const ownBooking = await getBookingForUser(payment.bookingId, userId)
    if (!ownBooking) {
      const isAdmin = await authorizeRole(request, 'admin')
      if (!isAdmin) {
        return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
      }

      const adminBooking = await getBookingById(payment.bookingId)
      if (!adminBooking) {
        return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
      }
    }

    const refund = await paymentService.refund({
      transactionId: id,
      refundAmount,
      reason,
      description,
    })

    return NextResponse.json({
      message: 'Refund processed successfully',
      refund,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process refund' },
      { status: 500 }
    )
  }
}
