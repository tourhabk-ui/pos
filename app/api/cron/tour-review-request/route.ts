/**
 * GET /api/cron/tour-review-request
 *
 * Гостевой опыт в брони, часть 1 (issue #1422). Запускается ежедневно.
 * Находит брони, которые ОПЕРАТОР пометил завершёнными (booking_status =
 * 'completed' — только так; ничего в коде не переводит бронь в этот статус
 * автоматически, и подставлять вместо него "дата тура + N часов" значило бы
 * утверждать, что поездка состоялась, когда мы этого не знаем, CLAUDE.md
 * §4.0), у которых есть привязанный аккаунт с Telegram (users.telegram_chat_id
 * — без него отправлять некуда, и это честно пропуск, а не ошибка) и кто ещё
 * не оставил отзыв и кому его ещё не предлагали (review_requested_at IS NULL,
 * миграция 918).
 *
 * После отправки ставит review_requested_at = NOW().
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { buildReviewRequestMessage } from '@/lib/notifications/guest-experience-copy';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

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
           u.telegram_chat_id::text AS telegram_chat_id
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    JOIN users u ON u.id = ob.user_id
    WHERE ob.booking_status = 'completed'
      AND ob.deleted_at IS NULL
      AND ob.review_requested_at IS NULL
      AND u.telegram_chat_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM operator_tour_reviews r
        WHERE r.user_id = ob.user_id AND r.tour_id = ot.id
      )
    LIMIT 200
  `);

  if (bookings.length === 0) {
    return NextResponse.json({ success: true, sent: 0, message: 'Нет завершённых броней без запроса отзыва' });
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
    booking_ids_sent: sent,
    timestamp: new Date().toISOString(),
  });
}
