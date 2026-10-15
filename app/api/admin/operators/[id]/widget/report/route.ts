/**
 * GET /api/admin/operators/[id]/widget/report[?probe_sites=1] — отчёт о
 * виджете одного партнёра для карточки оператора в админке (аудит 15.10,
 * находка WID-screens, W7).
 *
 * Тот же отчёт, что видит оператор в кабинете (/api/hub/operator/widget):
 * те же запросы, что перепись (widgetReportForPartner). С `probe_sites=1` —
 * ещё и проба главных по доменам из списка тем же правилом, что у переписи
 * (probeSite: только публичные имена, переадресации вручную, таймаут 10 с):
 * это и есть свежий итог «стоит ли код на сайте». Без параметра сайт не
 * опрашивается, и экран пишет «не проверено».
 *
 * Исходы (§4.0): не-uuid — 400 до базы; партнёра нет — 404; партнёр не
 * прочитался — 503 и строка в логе; отказ части — 200 с её именем в
 * failed_measures.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { isUuid } from '@/lib/text/slugify';
import { widgetReportForPartner } from '@/lib/analytics/widget-census';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Неверный идентификатор оператора' }, { status: 400 });
  }

  const probeSites = request.nextUrl.searchParams.get('probe_sites') === '1';
  const outcome = await widgetReportForPartner(pool, id, { probeSites });
  if (outcome.kind === 'unavailable') {
    console.error('[admin/widget-report] отчёт о виджете не построен:', `operator=${id}`, `sqlstate=${outcome.sqlstate}`);
    return NextResponse.json({ error: 'Отчёт о виджете не загрузился — ошибка базы' }, { status: 503 });
  }
  if (outcome.kind === 'not_found') {
    return NextResponse.json({ error: 'Оператор не найден' }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: outcome.report });
}
