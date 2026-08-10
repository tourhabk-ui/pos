/**
 * GET /api/cron/verdict-census?secret=<CRON_SECRET>[&limit=N]
 *
 * Перепись вердиктов по всем маршрутам: сколько сегодня «Идти», сколько
 * «Осторожно», сколько «Не сегодня», и по каким причинам.
 *
 * Зачем: владелец назвал риск до выката — «не пережестить, а то все маршруты
 * станут красными». Единственный способ это проверить — посчитать схему на
 * всём справочнике и посмотреть распределение. Отсюда же видно, где схема
 * упирается не в опасность, а в наше незнание: `signal_null` растёт, когда
 * источник молчит, и это другой разговор, чем «на Камчатке плохая погода».
 *
 * READ-ONLY, под CRON_SECRET: наружу это не нужно, а probe-url умеет ходить
 * в /api/cron/ со своим заголовком.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runVerdictCensus } from '@/lib/routes/verdict-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('limit');
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

  try {
    const census = await runVerdictCensus(limit);
    return NextResponse.json({ success: true, ...census });
  } catch (err) {
    // Перепись — диагностика; молчаливый пустой ответ здесь был бы хуже
    // ошибки, потому что читался бы как «маршрутов нет».
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Перепись не выполнена' },
      { status: 500 },
    );
  }
}
