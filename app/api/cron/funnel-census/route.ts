/**
 * GET /api/cron/funnel-census?secret=<CRON_SECRET>&days=7
 *     …&range=today|yesterday|7d|30d   или   …&date=ГГГГ-ММ-ДД
 *
 * Перепись воронки. Только чтение, ничего не меняет.
 *
 * ЗАЧЕМ. Разговор «где у нас дыра в воронке» упирается в цифры, которых
 * никто не видит. Три существующих среза (`/api/health/booking-funnel`,
 * `/api/health/selection-funnel`, `/api/admin/analytics/funnel`) закрыты
 * `requireAdmin` — с раннера и из переписки они недостижимы. Объектив
 * эволюции `scanFunnel` считает ровно то же, но наружу отдаёт ОДНУ находку
 * («самое верхнее сломанное звено») и молчит про сами числа: по вердикту
 * «каталог не ведёт к турам» нельзя понять, тысяча это визитов или три.
 *
 * ВЕРДИКТ НЕ СВОЙ. Звено называет `pickFunnelFinding` из
 * `lib/agents/evo/growth-agent` — тот же судья, что судит в петле эволюции.
 * Заводить здесь второе правило «что считать дырой» запрещено: два правила
 * разойдутся, и мы будем чинить не то, на что ругается петля.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0). Каждый замер отвечает числом ИЛИ «не смог», и
 * это разные вещи. Упавший запрос НЕ превращается в ноль: ноль визитов —
 * это факт о туристах, а отказ запроса — факт о нас. Поэтому:
 *   - каждый счётчик имеет тип `number | null`;
 *   - вердикт выносится, только если известны ВСЕ входы; иначе
 *     `verdict: null` и список того, что не сосчиталось;
 *   - `meaningful: false`, когда судить не по чему.
 *
 * ЧТО РАЗЛИЧАЕТ ЭТА ПЕРЕПИСЬ, А ОБЪЕКТИВ — НЕТ. Три пары состояний, которые
 * в одной цифре «0» неотличимы, а чинятся по-разному:
 *   - «визитов нет» против «ходят одни краулеры» — `bot_views` отдельно;
 *   - «форму брони не трогали» против «маяк никогда не работал» —
 *     `beacon_last_at` и `beacon_rows_total`;
 *   - «на сайт не заходят» против «счётчик просмотров умер» —
 *     `views_last_at` и `views_rows_total`.
 * Первое лечится привлечением, второе — починкой кода. Спутать их значит
 * месяц чинить не ту половину.
 *
 * ОКНО (29.09, владелец: «не только за 7 дней, но и за день»). Считает
 * `lib/analytics/funnel-window` — тем же модулем, что страница
 * `/hub/admin/traffic`. Здесь остались только вход по секрету крона и разбор
 * параметров: `days` (скользящее окно, как раньше), `range` и `date` (сутки
 * по Камчатке). Своих запросов у переписи больше нет — второй экземпляр
 * подсчёта разошёлся бы с первым (§12).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { buildFunnelReport, resolveFunnelWindow } from '@/lib/analytics/funnel-window';

// Прежние имена остаются здесь: их импортируют сторожа и объектив эволюции.
export { measure, verdictFrom, type Measured } from '@/lib/analytics/funnel-window';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const q = req.nextUrl.searchParams;
  const resolved = resolveFunnelWindow({
    range: q.get('range'),
    date: q.get('date'),
    days: q.get('days'),
  });
  // Непонятный запрос — отказ со словами, а не молчаливые семь суток: цифры
  // «за неделю» под видом «за день» хуже отсутствия цифр.
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
  }

  const report = await buildFunnelReport(resolved.window);
  return NextResponse.json({ ok: true, probe: 'funnel_census_v1', ...report });
}
