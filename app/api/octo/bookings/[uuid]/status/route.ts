/**
 * PATCH /api/octo/bookings/{uuid}/status
 *
 * Update booking status: CONFIRMED → REDEEMED (attended) or NO_SHOW
 * Required for completing booking lifecycle on OTA platforms.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOctoAuth, octoError, applyOctoRateLimitHeaders } from '@/lib/octo/auth';
import { pool } from '@/lib/db-pool';
import { mapBooking } from '@/lib/octo/mappers';
import { getBookingByUuid } from '@/lib/octo/service';
import { notifyOctoWebhooks } from '@/lib/octo/webhooks';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

// Status transition schema
const StatusTransitionSchema = z.object({
  status: z.enum(['REDEEMED', 'NO_SHOW']),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ uuid: string }> }
) {
  const authResult = await requireOctoAuth(request);
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  // Неявка и «пришёл» меняют бронь — то же право, что отмена и подтверждение.
  if (!authResult.canCreateBookings) {
    const err = octoError(403, 'FORBIDDEN', 'API key lacks booking permission');
    return applyOctoRateLimitHeaders(err, authResult);
  }

  try {
    const { uuid } = await params;

    // Validate request body
    let body;
    try {
      body = await request.json();
    } catch {
      const err = octoError(400, 'BAD_REQUEST', 'Invalid JSON');
      return applyOctoRateLimitHeaders(err, authResult);
    }

    const parsed = StatusTransitionSchema.safeParse(body);
    if (!parsed.success) {
      const err = octoError(400, 'BAD_REQUEST', parsed.error.issues[0].message);
      return applyOctoRateLimitHeaders(err, authResult);
    }

    const { status } = parsed.data;

    // Map OCTO status to internal status
    const internalStatus = status === 'REDEEMED' ? 'completed' : 'no_show';
    const webhookEvent = status === 'REDEEMED' ? 'booking:redeemed' : 'booking:no_show';

    // Бронь — только этого ключа (lib/octo/service.ts, getBookingByUuid):
    // по одному номеру любой ключ отмечал неявку у чужой брони и у брони
    // туриста с сайта (аудит 22.10). Чужая отвечает тем же 404.
    const bookingResult = await pool.query<{ id: string; booking_status: string }>(
      `SELECT id, booking_status
       FROM operator_bookings
       WHERE octo_uuid = $1 AND octo_api_key_id = $2 AND deleted_at IS NULL`,
      [uuid, authResult.id]
    );

    if (bookingResult.rows.length === 0) {
      const err = octoError(404, 'NOT_FOUND', 'Booking not found');
      return applyOctoRateLimitHeaders(err, authResult);
    }

    const booking = bookingResult.rows[0];

    // Validate status transition: only CONFIRMED → REDEEMED or NO_SHOW
    if (booking.booking_status !== 'confirmed') {
      const err = octoError(
        422,
        'INVALID_STATE_TRANSITION',
        `Cannot transition from ${booking.booking_status} to ${status}. Only CONFIRMED bookings can be marked as REDEEMED or NO_SHOW.`
      );
      return applyOctoRateLimitHeaders(err, authResult);
    }

    // Переход условием в самом UPDATE: между чтением и записью бронь могли
    // отменить, и отменённая не должна стать «пришёл».
    const updateResult = await pool.query<{ id: string }>(
      `UPDATE operator_bookings
       SET booking_status = $1, updated_at = NOW()
       WHERE id = $2 AND octo_api_key_id = $3 AND booking_status = 'confirmed'
       RETURNING id`,
      [internalStatus, booking.id, authResult.id]
    );

    if (updateResult.rows.length === 0) {
      const err = octoError(
        409,
        'INVALID_STATE_TRANSITION',
        'Booking status changed while processing. Fetch the booking and retry.'
      );
      return applyOctoRateLimitHeaders(err, authResult);
    }

    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'operator_booking', sourceId: booking.id as string | number,
      actorKind: 'system', title: statusChangeTitle('operator_booking', booking.booking_status, internalStatus),
      payload: { from: booking.booking_status, to: internalStatus, channel: 'octo' },
    });

    // Log action
    await pool.query(
      `INSERT INTO octo_booking_log (booking_id, action, api_key_id, response_body)
       VALUES ($1, $2, $3, $4)`,
      [
        booking.id,
        `UPDATE_STATUS_${status}`,
        authResult.id,
        JSON.stringify({ status }),
      ]
    );

    // Ответ той же формы, что у чтения брони: с названием тура и опции.
    const full = await getBookingByUuid(uuid, authResult.id);
    if (!full) {
      const err = octoError(500, 'INTERNAL_ERROR', 'Status updated but failed to retrieve booking');
      return applyOctoRateLimitHeaders(err, authResult);
    }
    const mappedBooking = mapBooking(full);

    notifyOctoWebhooks(webhookEvent, booking.id, mappedBooking).catch((err) =>
      logSwallowedFailure('octo/status', 'notifyOctoWebhooks', err),
    );

    const response = NextResponse.json(mappedBooking, { status: 200 });
    return applyOctoRateLimitHeaders(response, authResult);
  } catch (error) {
    // Отказ называется в логе: имя и SQLSTATE, без строки брони (§4.0).
    const e = error as { code?: string; message?: string };
    console.error('[octo/status] смена статуса не выполнилась', {
      sqlstate: e?.code ?? null,
      message: e?.message,
    });
    const err = octoError(500, 'INTERNAL_ERROR', 'Internal server error');
    return applyOctoRateLimitHeaders(err, authResult);
  }
}
