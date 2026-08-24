/**
 * GET /api/cron/route-core-sources?secret=<CRON_SECRET>&ids=id1,id2,...
 *
 * ДИАГНОСТИКА, не починка. Отвечает на один вопрос про конкретные записи
 * ядра Ф5 (route-core): у 15 из 20 нет линии и точек вовсе. Прежде чем
 * говорить «нужны полевые GPS-треки» (план прямо очерчивает эту границу —
 * ROUTES_ORDER_PLAN.md, «Границы, которые нельзя маскировать работой с
 * данными»), нужно исключить более дешёвый случай: источник записан, но
 * геометрия из него не забиралась.
 *
 * Смотрит НА КАЖДУЮ запись: есть ли source_url/pdf_url/park_approval_url,
 * длину описания и опасностей — то есть сколько у нас уже есть текста,
 * из которого потенциально можно вытащить путевые точки, если источник
 * вообще существует.
 *
 * READ-ONLY, ничего не решает и не пишет. Список id передаётся явно —
 * без него роут не гадает, какие 20 сейчас в ядре (ядро меняется).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Row {
  id: string;
  title: string | null;
  source_url: string | null;
  pdf_url: string | null;
  park_approval_url: string | null;
  mchs_phone: string | null;
  description_len: number;
  hazards_count: number;
  dedupe_key: string | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('ids') ?? '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Передайте ?ids=id1,id2,...' }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT id::text, title, source_url, pdf_url, park_approval_url, mchs_phone,
              COALESCE(LENGTH(description), 0) AS description_len,
              COALESCE(ARRAY_LENGTH(hazards, 1), 0) AS hazards_count,
              dedupe_key
         FROM kamchatka_routes
        WHERE id::text = ANY($1::text[])
        ORDER BY id`,
      [ids],
    );

    const summary = rows.map((r) => ({
      id: r.id,
      title: r.title,
      has_source_url: Boolean(r.source_url),
      source_url: r.source_url,
      has_pdf: Boolean(r.pdf_url),
      pdf_url: r.pdf_url,
      has_park_approval_url: Boolean(r.park_approval_url),
      has_mchs_phone: Boolean(r.mchs_phone),
      description_len: r.description_len,
      hazards_count: r.hazards_count,
      dedupe_key: r.dedupe_key,
      // Есть ХОТЬ ЧТО-ТО, откуда можно попытаться забрать путь, или это
      // запись без единого адреса — тогда починка действительно требует
      // не импорта, а поиска источника заново (GPX оператора, полевой трек).
      has_any_lead: Boolean(r.source_url || r.pdf_url || r.park_approval_url),
    }));

    return NextResponse.json({
      success: true,
      probe: 'route_core_sources_v1',
      checked: rows.length,
      requested: ids.length,
      not_found: ids.filter((id) => !rows.some((r) => r.id === id)),
      with_any_lead: summary.filter((s) => s.has_any_lead).length,
      without_any_lead: summary.filter((s) => !s.has_any_lead).length,
      rows: summary,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Диагностика не выполнена' },
      { status: 500 },
    );
  }
}
