/**
 * GET /api/cron/emsd-vmon-sync — записать суточную сводку КФ ФИЦ ЕГС РАН о
 * вулканах (www.emsd.ru/vmon) в volcano_bulletin_kfegs. Её читает радар
 * рядом с авиационным кодом KVERT (решение владельца 24.09: «показывай обе
 * шкалы на радаре»).
 *
 * Зовут: супервизор start.js (раз в час) и шаг cron-safety-heartbeat.yml
 * (каждые 30 мин). Аренда окна на час: из двух планировщиков в одном часе
 * работает первый. Сводка выходит раз в сутки, и чаще раза в час ходить к
 * серверу института незачем.
 *
 * Не дошли или не разобрали — ответ 502 и 'failed' в журнале прогона, а не
 * 200 с нулём вулканов: пустота читалась бы как «все спокойны».
 *
 * Авторизация: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { syncEmsdVmon } from '@/lib/services/safety/emsd-vmon-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WINDOW_MIN = 60;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const lease = await claimCronWindow('emsd-vmon-sync', WINDOW_MIN, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody('emsd-vmon-sync', WINDOW_MIN));

  const started = Date.now();
  try {
    const r = await syncEmsdVmon();
    if (!r.ok) {
      console.error('[emsd-vmon-sync] сводка не записана:', r.reason, r.problems.join('; '));
      recordCronRun('emsd-vmon-sync', started, 'failed', { error: r.reason ?? 'причина не названа' });
      return NextResponse.json({ success: false, ...r, duration_ms: Date.now() - started }, { status: 502 });
    }
    recordCronRun('emsd-vmon-sync', started, 'success', { items: r.written });
    return NextResponse.json({ success: true, ...r, duration_ms: Date.now() - started });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[emsd-vmon-sync] прогон не удался:', msg);
    recordCronRun('emsd-vmon-sync', started, 'failed', { error: msg });
    return NextResponse.json({ success: false, error: msg, duration_ms: Date.now() - started }, { status: 500 });
  }
}
