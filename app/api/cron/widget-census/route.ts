/**
 * GET /api/cron/widget-census[?probe_sites=1] — перепись виджетов партнёров:
 * домены, выдачи и открытия за 30 дней по хосту, разговоры чата и заявки
 * формы за 30/90 дней, псевдолиды чата и сколько из них ушло другим
 * операторам; с `probe_sites=1` — есть ли наш скрипт на главной каждого
 * домена (found / not_found / could_not_check, таймаут 10 с).
 *
 * Только чтение. Часть, которая не прочиталась, названа в `failed_measures`,
 * а не показана нулём. Повод и правила — lib/analytics/widget-census.ts
 * (аудит 15.10, находка WID-measure).
 *
 * Запускается рукой (manual): по адресу с CRON_SECRET, с раннера prod-check.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { censusWidgets } from '@/lib/analytics/widget-census';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const probeSites = req.nextUrl.searchParams.get('probe_sites') === '1';
  const report = await censusWidgets(pool, { probeSites });
  return NextResponse.json({
    ok: report.failed_measures.length === 0,
    probe: 'widget_census_v1',
    probe_sites: probeSites,
    ...report,
  });
}
