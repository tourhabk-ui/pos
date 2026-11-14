/**
 * GET /api/cron/unowned-leads-access-census
 *
 * Сколько аккаунтов с ролью оператора проходило к заявкам без адресата до
 * 14.11 и скольким из них список закрыт теперь; сколько таких заявок в базе
 * (`lib/leads/unowned-access-census`). Только числа.
 *
 * READ-ONLY, под CRON_SECRET; зовётся рукой через prod-check. Имён, почт,
 * телефонов и id в ответе нет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runUnownedAccessCensus } from '@/lib/leads/unowned-access-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const census = await runUnownedAccessCensus();
    return NextResponse.json({
      ok: true, probe: 'unowned_leads_access_v1', collected_at: new Date().toISOString(), ...census,
    });
  } catch (err) {
    // Пустой ответ читался бы как «доступа ни у кого не было»: отказ называется отказом.
    const e = err as { code?: string };
    console.error('[unowned-leads-access-census] перепись не выполнена:', { sqlstate: e?.code ?? 'нет SQLSTATE' });
    return NextResponse.json({ ok: false, reason: 'база не ответила', sqlstate: e?.code ?? null }, { status: 500 });
  }
}
