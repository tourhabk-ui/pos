/**
 * GET /api/cron/route-permit-census
 *
 * Перепись условий посещения по живым маршрутам: какой случай у маршрута в
 * ответе агенту (lib/parks/route-permit) и где карточка маршрута показывает
 * способы КГБУ, а справочник парков этого не подтверждает (#3302, срез 4).
 *
 * READ-ONLY, под CRON_SECRET; зовётся рукой через prod-check. ПД в ответе нет:
 * названия маршрутов и территорий — публичные данные каталога.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runRoutePermitCensus } from '@/lib/parks/route-permit-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const census = await runRoutePermitCensus();
    return NextResponse.json({ success: true, ...census });
  } catch (err) {
    // Пустой ответ читался бы как «маршрутов нет»: отказ называется отказом.
    const e = err as { code?: string; message?: string };
    console.error('[route-permit-census] перепись не выполнена:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ success: false, error: 'Перепись не выполнена' }, { status: 500 });
  }
}
