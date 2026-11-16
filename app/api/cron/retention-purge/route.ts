/**
 * GET /api/cron/retention-purge — уборка технических журналов старше срока
 * хранения (#3388, п. 2, шаг 2). Правило и список таблиц —
 * `lib/legal/retention-purge.ts`.
 *
 * По умолчанию сухой прогон: только счёт, сколько строк попало бы под
 * удаление или обезличивание, — в базу ничего не пишется. `?apply=1` —
 * уборка пачками и запись в журнал `retention_purge_log`. В ответе только
 * таблицы и числа.
 *
 * Под CRON_SECRET; зовётся суточным шагом `.github/workflows/cron-client-errors.yml`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runRetentionPurge } from '@/lib/legal/retention-purge';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const apply = request.nextUrl.searchParams.get('apply') === '1';
  const run = await runRetentionPurge((sql, params) => pool.query(sql, params), { apply });
  return NextResponse.json({ ok: run.failed === 0, probe: 'retention_purge_v1', collected_at: new Date().toISOString(), ...run });
}
