/**
 * GET /api/cron/kvert-acc — периодический синк авиационных цветовых кодов (ACC)
 * вулканов из KVERT VONA в volcano_status (migration 728).
 *
 * Запускается GitHub Actions по расписанию (cron-kvert-acc.yml) с Bearer CRON_SECRET.
 * Сетевая выборка KVERT идёт с этого прод-сервера (российский IP Timeweb) —
 * поэтому KVERT доступен (не-РФ адресам он отдаёт 403).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { syncKvertAcc } from '@/lib/agents/kvert-sync';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const result = await syncKvertAcc();

    // Ноль распознанных вулканов — это отказ слоя, а не тихий день. KVERT
    // публикует авиационные коды по действующим вулканам постоянно, и пустой
    // разбор означает, что источник отдал не то. Прогоны 26-28.07 возвращали
    // fetched: 0 при HTTP 200 и зелёном статусе — слой стоял мёртвым ровно
    // тогда, когда Шивелуч выбросил пепел на 12 км, и по цифрам это было
    // неотличимо от работы. Зелёный прогон при несделанной работе опаснее
    // красного при сделанной: он гасит подозрение.
    if (result.fetched === 0) {
      const message = 'KVERT: распознано 0 вулканов — источник отдал не VONA';
      recordCronRun('kvert-acc', startedAt, 'failed', { error: message });
      return NextResponse.json({ success: false, error: message, ...result }, { status: 502 });
    }

    // Счётчик работы в телеметрию: без него успешный прогон неотличим от
    // холостого уже на уровне истории, и сторож холостых кронов слеп.
    recordCronRun('kvert-acc', startedAt, 'success', { items: result.fetched });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синка KVERT';
    recordCronRun('kvert-acc', startedAt, 'failed', { error: message });
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
