/**
 * GET /api/cron/tour-review-request
 *
 * Гостевой опыт в брони, часть 1 (issue #1422). Запускается ежедневно.
 * Находит завершённые брони (booking_status = 'completed'), у которых есть
 * привязанный аккаунт с Telegram, кто ещё не оставил отзыв и кому его ещё не
 * предлагали (review_requested_at IS NULL, миграция 918).
 *
 * Завершённой бронь делает оператор («Завершить тур») — или, с 13.10 по
 * решению владельца («тур завершать автоматически»), автоматическое
 * завершение на следующий день после даты тура (/api/cron/booking-auto-complete,
 * тот же workflow, шагом раньше).
 *
 * Адрес — TOURIST_TG_CHAT_SQL (lib/notifications/tourist-telegram): до 13.10
 * отбор шёл по users.telegram_chat_id, которую не пишет никто, и просьба не
 * уходила ни одному туристу с сайта. Завершённые брони без Telegram — не
 * «нечего делать», а «некуда писать»: их число в ответе (no_channel).
 *
 * Окно — REVIEW_REQUEST_MAX_AGE_DAYS от последнего дня тура (13.10). Пока
 * адрес не работал, завершённые брони копились без просьбы, а автозавершение
 * добавит к ним все прошедшие подтверждённые; без окна первый же рабочий
 * прогон спросил бы «как прошла поездка?» про поездки многомесячной давности.
 *
 * После отправки ставит review_requested_at = NOW().
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { buildReviewRequestMessage, REVIEW_REQUEST_MAX_AGE_DAYS } from '@/lib/notifications/guest-experience-copy';
import { getPublicBaseUrl } from '@/lib/config';
import { TOURIST_TG_CHAT_SQL } from '@/lib/notifications/tourist-telegram';
import { TOUR_LAST_DAY_SQL } from '@/lib/bookings/tour-last-day';

export const dynamic = 'force-dynamic';

/** Последний день тура не раньше окна — по Камчатке, как и автозавершение. */
const RECENT_TOUR_SQL =
  `${TOUR_LAST_DAY_SQL} >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date - $1::int`;

interface CompletedBookingRow {
  id: number;
  tourist_name: string | null;
  tour_id: number;
  tour_title: string;
  telegram_chat_id: string;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { rows: bookings } = await pool.query<CompletedBookingRow>(`
    SELECT ob.id, ob.tourist_name, ot.id AS tour_id, ot.title AS tour_title,
           (${TOURIST_TG_CHAT_SQL})::text AS telegram_chat_id
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    JOIN users u ON u.id = ob.user_id
    WHERE ob.booking_status = 'completed'
      AND ob.deleted_at IS NULL
      AND ob.review_requested_at IS NULL
      AND ${RECENT_TOUR_SQL}
      AND ${TOURIST_TG_CHAT_SQL} IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM operator_tour_reviews r
        WHERE r.user_id = ob.user_id AND r.tour_id = ot.id
      )
    LIMIT 200
  `, [REVIEW_REQUEST_MAX_AGE_DAYS]);

  // Завершённые в том же окне без отзыва, но писать некуда: без аккаунта или без Telegram.
  const { rows: noChannelRows } = await pool.query<{ n: number }>(`
    SELECT COUNT(*)::int AS n
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    LEFT JOIN users u ON u.id = ob.user_id
    WHERE ob.booking_status = 'completed'
      AND ob.deleted_at IS NULL
      AND ob.review_requested_at IS NULL
      AND ${RECENT_TOUR_SQL}
      AND (u.id IS NULL OR ${TOURIST_TG_CHAT_SQL} IS NULL)
  `, [REVIEW_REQUEST_MAX_AGE_DAYS]);
  const noChannel = noChannelRows[0]?.n ?? 0;

  if (bookings.length === 0) {
    return NextResponse.json({ success: true, sent: 0, no_channel: noChannel, message: 'Нет завершённых броней без запроса отзыва, которым есть куда написать' });
  }

  const appUrl = getPublicBaseUrl();
  const sent: number[] = [];
  const failed: number[] = [];

  for (const b of bookings) {
    const text = buildReviewRequestMessage({
      touristName: b.tourist_name,
      tourTitle: b.tour_title,
      tourId: b.tour_id,
      appUrl,
    });

    const ok = await sendTelegramMessage(b.telegram_chat_id, text);
    if (!ok) { failed.push(b.id); continue; }

    await pool.query(
      `UPDATE operator_bookings SET review_requested_at = NOW() WHERE id = $1`,
      [b.id],
    );
    sent.push(b.id);
  }

  return NextResponse.json({
    success: true,
    sent: sent.length,
    failed: failed.length,
    no_channel: noChannel,
    booking_ids_sent: sent,
    timestamp: new Date().toISOString(),
  });
}
