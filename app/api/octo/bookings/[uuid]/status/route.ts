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
import { notifyOctoWebhooks } from '@/lib/octo/webhooks';

interface OctoBookingRow {
  id: string;
  octo_uuid: string;
  booking_status: string;
  operator_tour_id: string;
  booking_date: string;
  participants: number;
  adult_count: number | null;
  child_count: number | null;
  final_price: string | null;
  currency: string;
  tourist_name: string | null;
  tourist_email: string | null;
  tourist_phone: string | null;
  special_requests: string | null;
  hold_expires_at: string | null;
  created_at: string;
  updated_at: string | null;
  tour_title: string;
  option_name: string | null;
  option_id: string | null;
}

// Status transition schema
const StatusTransitionSchema = z.object({
  status: z.enum(['REDEEMED', 'NO_SHOW']),
});

type StatusTransition = z.infer<typeof StatusTransitionSchema>;

export async function PATCH(
  request: NextRequest,
  context: { params: { uuid: string } }
) {
  try {
    // Authenticate OCTO request
    const authResult = await requireOctoAuth(request);
    if (authResult instanceof NextResponse) {
      return authResult;
    }

    const { uuid } = context.params;

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
      const err = octoError(400, 'BAD_REQUEST', parsed.error.errors[0].message);
      return applyOctoRateLimitHeaders(err, authResult);
    }

    const { status } = parsed.data;

    // Map OCTO status to internal status
    const internalStatus = status === 'REDEEMED' ? 'completed' : 'no_show';
    const webhookEvent = status === 'REDEEMED' ? 'booking:redeemed' : 'booking:no_show';

    // Find booking by octo_uuid
    const bookingResult = await pool.query<OctoBookingRow>(
      `SELECT id, octo_uuid, booking_status, operator_tour_id, booking_date,
              participants, adult_count, child_count, final_price, currency,
              tourist_name, tourist_email, tourist_phone, special_requests
       FROM operator_bookings
       WHERE octo_uuid = $1 AND deleted_at IS NULL`,
      [uuid]
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

    // Update booking status
    const updateResult = await pool.query<OctoBookingRow>(
      `UPDATE operator_bookings
       SET booking_status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [internalStatus, booking.id]
    );

    const updatedBooking = updateResult.rows[0];

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

    // Send webhook notification
    const mappedBooking = mapBooking(updatedBooking);
    notifyOctoWebhooks(webhookEvent, booking.id, mappedBooking).catch(() => {});

    const response = NextResponse.json(mappedBooking, { status: 200 });
    return applyOctoRateLimitHeaders(response, authResult);
  } catch (error) {
    const authResult = await requireOctoAuth(request);
    const err = octoError(500, 'INTERNAL_ERROR', 'Internal server error');
    if (authResult instanceof NextResponse) {
      return err;
    }
    return applyOctoRateLimitHeaders(err, authResult);
  }
}
