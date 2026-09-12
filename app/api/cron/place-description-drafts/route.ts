/**
 * POST /api/cron/place-description-drafts — черновики описаний вулканов из
 * Global Volcanism Program (#1830).
 *
 * Тянет `Remarks` (английский текст ГВП) для мест из подтверждённого реестра
 * `lib/geo/gvp-confirmed-pairs.ts`, переводит через `callAIQualityOrNull` и
 * пишет ЧЕРНОВИК в `place_description_drafts`. НИКОГДА не пишет в
 * `places.description` напрямую — публикация только через
 * `POST /api/admin/places/[id]/description-draft` (ручное ревью).
 *
 * Уже рассмотренные человеком черновики (`approved`/`rejected`) повторным
 * прогоном не переписываются — решение не отменяется молча.
 *
 * `dry_run=true` (по умолчанию) не зовёт AI и не пишет в БД — только
 * показывает охват (сколько Remarks нашлось, для каких мест). Тот же приём,
 * что у `place-coords`/`images-to-s3`.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runGvpRemarksDrafts } from '@/lib/geo/gvp-remarks-runner';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET — сколько черновиков реально записано, по статусу. Только чтение, без
 * AI и без перевода: нужна, чтобы проверить итог боевого прогона POST'а без
 * повторной траты бюджета на перевод (12.09: клиентский таймаут 580с оборвал
 * ответ ДО того, как узнали исход — сервер мог как раз тогда дописывать
 * последние черновики).
 */
export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await pool.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n
         FROM place_description_drafts
        WHERE source = 'gvp'
        GROUP BY status`,
    );
    const byStatus = Object.fromEntries(result.rows.map(r => [r.status, Number(r.n)]));

    return NextResponse.json({
      success: true,
      probe: 'place_description_drafts_status_v1',
      total: result.rows.reduce((sum, r) => sum + Number(r.n), 0),
      by_status: byStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения черновиков описаний';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRunParam = request.nextUrl.searchParams.get('dry_run');
  const dryRun = dryRunParam !== 'false';

  try {
    const result = await runGvpRemarksDrafts({ dryRun });

    const byStatus = result.outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      success: true,
      probe: 'place_description_drafts_v1',
      dry_run: dryRun,
      remarks_fetched_total: result.remarksFetchedTotal,
      places_total: result.outcomes.length,
      by_status: byStatus,
      outcomes: result.outcomes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка получения/перевода Remarks';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
