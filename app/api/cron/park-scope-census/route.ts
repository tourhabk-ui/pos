/**
 * GET /api/cron/park-scope-census — каким путём закрытие парка дошло до места.
 *
 * Слово владельца 22.11 «1 да»: прежде чем менять правило закрытия, замерить,
 * сколько мест попадает «в парк» только через проходящий маршрут (Халактырский
 * пляж, #3487). Разбор — lib/services/safety/park-scope-census.ts.
 *
 * Параметры (необязательные): `places` и `routes` — slug через запятую, не
 * больше 20 каждого; маршрут можно назвать и номером. READ-ONLY, под
 * CRON_SECRET; зовётся рукой через prod-check. ПД в ответе нет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { LOOKUP_LIMIT, runParkScopeCensus } from '@/lib/services/safety/park-scope-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SLUG_LIST = z.string().trim().max(1200).optional()
  .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
  .pipe(z.array(z.string().regex(/^[a-z0-9-]{1,120}$/i)).max(LOOKUP_LIMIT));

const QUERY = z.object({ places: SLUG_LIST, routes: SLUG_LIST });

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const parsed = QUERY.safeParse({ places: sp.get('places') ?? undefined, routes: sp.get('routes') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: `places и routes — slug через запятую (латиница, цифры, дефис), не больше ${LOOKUP_LIMIT} каждого` },
      { status: 400 },
    );
  }

  try {
    const census = await runParkScopeCensus(parsed.data);
    return NextResponse.json({ success: true, ...census });
  } catch (err) {
    // Пустой ответ читался бы как «таких мест нет»: отказ называется отказом.
    const e = err as { code?: string; message?: string };
    console.error('[park-scope-census] перепись не выполнена:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ success: false, error: 'Перепись не выполнена' }, { status: 500 });
  }
}
