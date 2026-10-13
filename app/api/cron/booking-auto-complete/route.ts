/**
 * GET /api/cron/booking-auto-complete — тур завершается сам на следующий день
 * после даты (решение владельца 13.10: «тур завершать автоматически»).
 *
 * Правило и путь — lib/bookings/auto-complete-past: подтверждённая бронь,
 * последний день тура прошёл по Камчатке, завершение тем же completeBooking,
 * что у кнопки оператора. Зовёт cron-tour-review-request.yml шагом раньше
 * просьбы об отзыве: завершённые сегодня брони получают её тем же вечером.
 *
 * Отказ отбора — 502 с SQLSTATE, а не «завершать нечего» (§4.0); отказ одной
 * брони — в ответе списком failed, остальные завершаются.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { autoCompletePastTours } from '@/lib/bookings/auto-complete-past';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const s = await autoCompletePastTours();
    return NextResponse.json({
      success: s.failed.length === 0,
      due: s.due,
      completed: s.completed.length,
      booking_ids_completed: s.completed,
      failed: s.failed,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const sqlstate = typeof code === 'string' ? logText(code, 10) : null;
    console.error('[booking-auto-complete] отбор броней не выполнен:', sqlstate ?? '', logText(err instanceof Error ? err.message : err, 200));
    return NextResponse.json(
      { success: false, error: 'Не удалось отобрать брони для завершения', sqlstate },
      { status: 502 },
    );
  }
}
