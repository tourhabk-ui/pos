/**
 * app/api/cron/routes-cache-refresh/route.ts
 * 
 * Обновляет AI-описания для маршрутов без кеша.
 * Запускается через GitHub Actions или cron-job.org ежедневно.
 * 
 * Используется для SEO: гарантирует свежесть описаний в кешe для Google.
 */

import { NextRequest, NextResponse } from 'next/server';
import { refreshRoutesWithoutCache } from '@/lib/services/routes/route-description-cache';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { withSpendAgent } from '@/lib/ai/usage-context';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export async function POST(req: NextRequest) {
  return withSpendAgent('routes-cache', async () => {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  // Общий хелпер вместо `!==`: сравнение постоянным временем (сторож
  // api-guard-before-action, 01.09).
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }
  const startedAt = Date.now();

  try {
    const limit = parseInt(req.nextUrl.searchParams.get('limit') || '50', 10);
    const updated = await refreshRoutesWithoutCache(limit);

    const message = `Routes description cache refreshed: ${updated} routes`;
    if (process.env.NODE_ENV !== 'production') {
      console.info('[routes-cache] ' + message);
    }

    recordCronRun('routes-cache', startedAt, 'success', { items: updated });
    return NextResponse.json({
      success: true,
      updated,
      message: `Refreshed ${updated} route descriptions`,
    });
  } catch (error) {
    const message = `Route description cache refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    if (process.env.NODE_ENV !== 'production') {
      console.error('[routes-cache] ' + message);
    }

    recordCronRun('routes-cache', startedAt, 'failed', { error: 'кэш описаний не обновился' });
    return NextResponse.json(
      { success: false, error: 'кэш описаний не обновился' },
      { status: 500 }
    );
  }
  });
}

export const dynamic = 'force-dynamic';
