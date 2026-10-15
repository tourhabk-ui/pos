/**
 * GET /api/hub/operator/widget — виджет Ведара на сайте оператора: включён
 * ли, домены из списка, отчёт за 30 дней (аудит 15.10, находка WID-screens,
 * W7; решение главной сессии по карт-бланшу владельца 15.10).
 *
 * До этого партнёр не видел ни кода вставки, ни результата: код передавался
 * через владельца и посредника, а отчёта не было вовсе.
 *
 * Только СВОЙ партнёр: кабинет находит общий резолвер (requireOperatorTeam —
 * SQL-связка до partners.user_id или командное место в operator_members), а
 * не параметр запроса. Никакой id из адреса здесь не читается.
 *
 * Отчёт — те же части и те же запросы, что перепись
 * (lib/analytics/widget-census.ts, widgetReportForPartner); только агрегаты,
 * ни имён, ни телефонов посетителей. Сайт этот роут не опрашивает: стоит ли
 * код на сайте, экран называет «не проверено» (site_probe: null).
 *
 * Исходы (§4.0): отчёт — 200; партнёр не прочитался — 503 и строка в логе с
 * SQLSTATE, а не «данных нет»; отказ ЧАСТИ отчёта — 200, часть null и названа
 * в failed_measures, экран пишет у неё «не загрузилось».
 *
 * Только чтение. Домены и включение правит администратор
 * (/api/admin/operators/[id]/widget).
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperatorTeam } from '@/lib/operators/team-access';
import { widgetReportForPartner } from '@/lib/analytics/widget-census';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ctx = await requireOperatorTeam(request, { noProfileStatus: 404 });
  if (ctx instanceof NextResponse) return ctx;

  const outcome = await widgetReportForPartner(pool, ctx.partnerId);
  if (outcome.kind === 'unavailable') {
    console.error('[hub/operator/widget] отчёт о виджете не построен:', `partner=${ctx.partnerId}`, `sqlstate=${outcome.sqlstate}`);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить данные виджета — попробуйте позже' },
      { status: 503 },
    );
  }
  if (outcome.kind === 'not_found') {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: outcome.report });
}
