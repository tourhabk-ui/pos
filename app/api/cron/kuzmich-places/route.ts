/**
 * GET /api/cron/kuzmich-places
 *
 * Генерирует kuzmich_review для мест где его ещё нет.
 * 20 мест за запуск, запускается ежедневно в 04:00 UTC.
 *
 * Auth: Authorization: Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { runKuzmichPlaceEnricher } from '@/lib/agents/kuzmich-place-enricher';

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  // Общий хелпер вместо разбора заголовка руками (сторож
  // api-guard-before-action, 01.09): одно место читает секрет, одно сравнивает.
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  try {
    const result = await runKuzmichPlaceEnricher(20);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
