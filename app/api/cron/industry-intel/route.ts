/**
 * GET /api/cron/industry-intel?secret=<CRON_SECRET>
 *
 * Market-intelligence из отраслевых Telegram-каналов гостеприимства/туризма (MTProto).
 * Читает последние сообщения → group-monitor извлекает тренды/конкурентов/сигналы
 * → agent_memory (intelligence) → доступно Scout/Кузьмичу/брифингу.
 *
 * Требует TG_API_ID / TG_API_HASH / TG_USER_SESSION (иначе тихо вернёт ошибку настройки).
 * Рекомендуемый интервал: 1-2 раза в день.
 */

import { NextRequest, NextResponse } from 'next/server';
import { scanIndustryChannels } from '@/lib/telegram/industry-channels';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await scanIndustryChannels(48);
    return NextResponse.json({ ok: result.errors.length === 0, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
