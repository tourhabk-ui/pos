/**
 * GET /api/cron/engagement
 * Проактивный реэнгейджмент Kuzmich — отправляет Telegram-напоминания туристам,
 * которые интересовались туром но не забронировали через 23-72 часа.
 *
 * Запуск: GitHub Actions каждые 6ч
 *   URL: https://vedarai.ru/api/cron/engagement?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { sendEngagementPushes, getEngagementStats } from '@/lib/kuzmich/engagement';
import { getCronSecret } from '@/lib/auth/cron';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic   = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request) ?? '';
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();

  try {
    const [result, stats] = await Promise.all([
      sendEngagementPushes(),
      getEngagementStats(),
    ]);

    recordCronRun('engagement', started, 'success', { items: result.sent });

    return NextResponse.json({
      ok: true,
      sent:    result.sent,
      skipped: result.skipped,
      stats,
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[engagement]', err instanceof Error ? err.message : err);
    recordCronRun('engagement', started, 'failed', { error: 'рассылка не выполнилась' });
    return NextResponse.json({ ok: false, error: 'рассылка не выполнилась' }, { status: 500 });
  }
}
