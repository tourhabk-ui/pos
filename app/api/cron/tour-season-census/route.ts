/**
 * GET /api/cron/tour-season-census
 *
 * Перепись сезонов живых туров: какие туры без календаря сегодня принимают
 * заявку на любую дату — потому что записанный сезон кончился или не записан
 * вовсе (`lib/tours/season-census`). Сезон следующего года перепись не
 * выводит: его называет оператор.
 *
 * READ-ONLY, под CRON_SECRET; зовётся рукой через prod-check. ПД в ответе нет:
 * названия туров и компаний — публичные данные витрины.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { runTourSeasonCensus } from '@/lib/tours/season-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const census = await runTourSeasonCensus(kamchatkaToday());
    // Живых туров нет — перепись не о чем: это отказ, а не «нарушений нет».
    const ok = census.tours_total > 0;
    return NextResponse.json(
      { ok, probe: 'tour_season_census_v1', collected_at: new Date().toISOString(), ...census },
      { status: ok ? 200 : 500 },
    );
  } catch (err) {
    // Пустой ответ читался бы как «таких туров нет»: отказ называется отказом.
    const e = err as { code?: string };
    console.error('[tour-season-census] перепись не выполнена:', { sqlstate: e?.code ?? 'нет SQLSTATE' });
    return NextResponse.json({ ok: false, reason: 'база не ответила', sqlstate: e?.code ?? null }, { status: 500 });
  }
}
