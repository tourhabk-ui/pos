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
 *
 * ?dry_run=1 — тот же отбор без завершения: кого завершил бы прогон. Завершение
 * необратимо («не явился» после него не поставить), и список стоит видеть до.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { autoCompletePastTours, listDueBookings } from '@/lib/bookings/auto-complete-past';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (request.nextUrl.searchParams.get('dry_run') === '1') {
      const ids = await listDueBookings();
      return NextResponse.json({
        success: true,
        dry_run: true,
        due: ids.length,
        booking_ids_due: ids,
        timestamp: new Date().toISOString(),
      });
    }
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
