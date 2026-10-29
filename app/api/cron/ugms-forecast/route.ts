/**
 * GET /api/cron/ugms-forecast — прочитать суточный прогноз Камчатского УГМС
 * (kammeteo.ru) и записать его по дням и районам в ugms_forecasts
 * (lib/weather/ugms-forecast; владелец 29.10: «есть же камчатский гидромет»).
 *
 * Зовут: супервизор start.js (раз в час) и шаг cron-safety-heartbeat.yml
 * (каждые 30 мин), оба с Bearer CRON_SECRET; аренда окна на час — прогноз
 * выходит несколько раз в сутки, чаще раза в час ходить к УГМС незачем.
 *
 * Три исхода (§4.0): записано; одна из двух страниц не дошла — записано, что
 * дошло, отказ назван в ответе; ни одной — 502, 'failed' в журнале прогона,
 * здоровье источника 'error' с причиной. Ноль записанных при HTTP 200 — тоже
 * отказ: страница есть всегда, пустой разбор значит, что разметка изменилась.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { recordSourceHealth, SAFETY_SOURCE_EXPECTATIONS } from '@/lib/services/safety/source-health';
import { syncUgmsForecast } from '@/lib/weather/ugms-forecast';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const AGENT_ID = 'ugms-forecast';
const WINDOW_MIN = 60;
const SOURCE_KEY = 'ugms_forecast';

function sourceLabel(): string {
  return SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === SOURCE_KEY)?.label ?? 'Камчатское УГМС — прогноз (kammeteo.ru)';
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const lease = await claimCronWindow(AGENT_ID, WINDOW_MIN, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody(AGENT_ID, WINDOW_MIN));

  const started = Date.now();
  try {
    const r = await syncUgmsForecast();
    const health = r.ok
      ? { key: SOURCE_KEY, label: sourceLabel(), status: 'ok' as const, rawItems: r.written, inserted: r.written, aliveBy: 'raw_items' as const }
      : { key: SOURCE_KEY, label: sourceLabel(), status: 'error' as const, rawItems: 0, inserted: 0, aliveBy: 'raw_items' as const, error: r.problems.join('; ').slice(0, 500) };
    await recordSourceHealth(pool, [health])
      .catch((err: unknown) => console.error('[ugms-forecast] здоровье источника не записано:', err instanceof Error ? err.message : err));

    if (!r.ok) {
      const reason = r.problems.join('; ') || 'ни одного блока прогноза не записано';
      console.error('[ugms-forecast] прогноз не записан:', reason);
      recordCronRun(AGENT_ID, started, 'failed', { error: reason });
      return NextResponse.json({ success: false, ...r, duration_ms: Date.now() - started }, { status: 502 });
    }
    if (r.problems.length) console.error('[ugms-forecast] часть страниц не прочитана:', r.problems.join('; '));
    recordCronRun(AGENT_ID, started, 'success', { items: r.written });
    return NextResponse.json({ success: true, ...r, duration_ms: Date.now() - started });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ugms-forecast] прогон не удался:', msg);
    recordCronRun(AGENT_ID, started, 'failed', { error: msg });
    return NextResponse.json({ success: false, error: msg, duration_ms: Date.now() - started }, { status: 500 });
  }
}
