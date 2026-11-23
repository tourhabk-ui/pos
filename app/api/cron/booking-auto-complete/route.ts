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
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const startedAt = Date.now();

  try {
    if (request.nextUrl.searchParams.get('dry_run') === '1') {
      const ids = await listDueBookings();
      // Сухой прогон отметки не ставит: строка «success» держала бы молчащий
      // крон живым в панели, хотя ни одна бронь не завершена.
      return NextResponse.json({
        success: true,
        dry_run: true,
        due: ids.length,
        booking_ids_due: ids,
        timestamp: new Date().toISOString(),
      });
    }
    const s = await autoCompletePastTours();
    recordCronRun('booking-auto-complete', startedAt, s.failed.length === 0 ? 'success' : 'partial', {
      items: s.completed.length,
      error: s.failed.length ? 'часть броней не завершилась' : undefined,
    });
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
    recordCronRun('booking-auto-complete', startedAt, 'failed', { error: 'не удалось отобрать брони' });
    return NextResponse.json(
      { success: false, error: 'Не удалось отобрать брони для завершения', sqlstate },
      { status: 502 },
    );
  }
}
