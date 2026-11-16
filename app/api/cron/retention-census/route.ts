/**
 * GET /api/cron/retention-census — сколько строк старше сроков хранения,
 * обещанных политикой (#3388, п. 2). Только числа и даты; без имён, телефонов
 * и id. Только чтение.
 *
 * Под CRON_SECRET; зовётся рукой через prod-check. Правило и список таблиц —
 * `lib/legal/retention-census.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runRetentionCensus } from '@/lib/legal/retention-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const census = await runRetentionCensus((sql, params) => pool.query(sql, params));
  return NextResponse.json({ ok: true, probe: 'retention_census_v1', collected_at: new Date().toISOString(), ...census });
}
