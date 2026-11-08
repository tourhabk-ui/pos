/**
 * GET /api/cron/webmaster-census?days=90 — Яндекс Вебмастер для vedarai.ru:
 * страницы в поиске, исключённые с причинами, запросы с показами и кликами.
 * Bearer CRON_SECRET. Только читает — у API Вебмастера здесь не зовётся ни
 * один пишущий метод.
 *
 * Токен ищется среди переменных окружения по ИМЕНИ (lib/seo/webmaster-census):
 * владелец 08.11 сказал, что он «в переменных», а имя нигде не записано. В
 * ответе — только имя найденной переменной и исходы проверки, значение не
 * выходит наружу ни при каком исходе.
 *
 * Запускается маркером prod-check (ответ попадает в лог прогона), расписания
 * нет: перепись — для решения человека о пункте 1 плана SEO.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { webmasterCensus, type Fetcher } from '@/lib/seo/webmaster-census';
import { kamchatkaToday } from '@/lib/planner/calendar-days';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const fetcher: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const days = clampInt(request.nextUrl.searchParams.get('days'), 90, 7, 365);
  const top = clampInt(request.nextUrl.searchParams.get('top'), 200, 10, 500);
  try {
    const census = await webmasterCensus({ env: process.env, fetcher, today: kamchatkaToday(), days, topQueries: top });
    if (!census.token.found_as) {
      console.error('[webmaster-census] токен Вебмастера не найден или не принят', {
        tried: census.token.tried.map((t) => `${t.name}: ${t.result}`),
      });
    }
    return NextResponse.json({ days, ...census });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[webmaster-census] перепись не выполнилась:', message);
    return NextResponse.json({ error: 'Перепись Вебмастера не выполнилась', detail: message }, { status: 502 });
  }
}
