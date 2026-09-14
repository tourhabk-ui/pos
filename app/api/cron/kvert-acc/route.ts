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

    // Разобрать коды — половина работы. Вторая половина: довести их до
    // карточки места. Она проваливалась молча (владелец 14.09 прислал
    // страницу ГВП: Шивелуч извергается, код Orange — а зелёный прогон этого
    // не подтверждал).
    //
    // `places_indexed` и `matched` считались с самого начала, и у первого в
    // типе прямо написано «Ноль — сопоставлять не с чем, и это отказ». Но не
    // читал их НИКТО: краснел только `fetched === 0`. Объявленный исход без
    // механизма зеленеет ровно там, где механизма нет (правило 10.09) — и
    // зеленел бы при полностью разобранном источнике и нуле обновлённых
    // карточек.
    //
    // Причины разделены, потому что чинятся в разных местах: пустой индекс —
    // это каталог или запрос к нему, ноль сопоставлений при живом индексе —
    // это таблица алиасов и сам матчер. `unmatched_reasons` в теле ответа
    // называет виновника поимённо, здесь — только род отказа.
    if (result.places_indexed === 0) {
      const message = 'KVERT: в каталоге ноль точек-вулканов — сопоставлять не с чем';
      recordCronRun('kvert-acc', startedAt, 'failed', { error: message });
      return NextResponse.json({ success: false, error: message, ...result }, { status: 502 });
    }

    if (result.matched === 0) {
      const message = `KVERT: разобрано ${result.fetched}, сопоставлено с местами 0 — коды никуда не доехали`;
      recordCronRun('kvert-acc', startedAt, 'failed', { error: message });
      return NextResponse.json({ success: false, error: message, ...result }, { status: 502 });
    }

    // Счётчик работы в телеметрию: без него успешный прогон неотличим от
    // холостого уже на уровне истории, и сторож холостых кронов слеп.
    //
    // Считается СОПОСТАВЛЕННОЕ, а не разобранное: сторож холостых прогонов
    // должен видеть доведённую до места работу, иначе он охраняет чтение
    // чужой страницы, а не нашу пользу от неё.
    recordCronRun('kvert-acc', startedAt, 'success', { items: result.matched });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синка KVERT';
    recordCronRun('kvert-acc', startedAt, 'failed', { error: message });
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
