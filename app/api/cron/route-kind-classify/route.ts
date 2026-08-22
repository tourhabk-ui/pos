/**
 * Разметка рода записи: путь или «как добраться» (решение владельца 22.08).
 *
 * Судит не имя поставщика и не размах габаритов, а улика в самих данных —
 * судья принадлежности (lib/routes/line-ownership):
 *
 *   own_with_approach → approach  линия доходит до места, но начинается за
 *                                 десятки километров: в неё записана дорога
 *                                 заброски. Это «как добраться».
 *   own               → path      линия у своего места, подъезда нет.
 *   foreign / unclear → NULL      род не установлен. Третий исход не равен
 *                                 ни одному из первых двух (§4.0): запись
 *                                 без линии молчит о своём роде, и молчание
 *                                 не заполняется удобным ответом.
 *
 * Ничего, кроме двух колонок рода, не трогается: ни геометрия, ни имя, ни
 * описание. Ошиблись — `UPDATE ... SET route_kind = NULL`, данные целы.
 *
 * По умолчанию СУХОЙ прогон: боевой только при `?apply=1`. READ-ONLY без
 * него — чтобы перепись рода можно было снять пробой, ничего не меняя.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { lineOwnership } from '@/lib/routes/line-ownership';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Row {
  id: string; title: string;
  lat: string | null; lng: string | null;
  coords: unknown; kind: string | null;
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  const apply = request.nextUrl.searchParams.get('apply') === '1';

  try {
    const { rows } = await pool.query<Row>(
      `SELECT r.id::text AS id, r.title,
              r.lat::text AS lat, r.lng::text AS lng,
              r.geometry->'coordinates' AS coords,
              r.route_kind AS kind
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
       ORDER BY r.title`,
    );

    const decided: Array<{ id: string; title: string; kind: 'path' | 'approach'; reason: string }> = [];
    let unset = 0;

    for (const r of rows) {
      const coords = Array.isArray(r.coords) ? (r.coords as number[][]) : null;
      const lat = r.lat === null ? NaN : parseFloat(r.lat);
      const lng = r.lng === null ? NaN : parseFloat(r.lng);
      const own = lineOwnership({
        routePoint: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
        coords,
      });
      if (own.verdict === 'own_with_approach') {
        decided.push({
          id: r.id, title: r.title, kind: 'approach',
          reason: own.reasons.join(' '),
        });
      } else if (own.verdict === 'own') {
        decided.push({
          id: r.id, title: r.title, kind: 'path',
          reason: own.reasons.join(' '),
        });
      } else {
        unset++;
      }
    }

    let applied = 0;
    if (apply && decided.length > 0) {
      // Одним запросом на партию: разметка рода не должна оставлять базу
      // наполовину размеченной, если соединение оборвётся посередине.
      const ids = decided.map(d => d.id);
      const kinds = decided.map(d => d.kind);
      const reasons = decided.map(d => d.reason.slice(0, 400));
      const res = await pool.query(
        `UPDATE kamchatka_routes AS r
         SET route_kind = v.kind, route_kind_reason = v.reason, updated_at = NOW()
         FROM (
           SELECT UNNEST($1::uuid[]) AS id,
                  UNNEST($2::text[]) AS kind,
                  UNNEST($3::text[]) AS reason
         ) AS v
         WHERE r.id = v.id
           AND (r.route_kind IS DISTINCT FROM v.kind
                OR r.route_kind_reason IS DISTINCT FROM v.reason)`,
        [ids, kinds, reasons],
      );
      applied = res.rowCount ?? 0;
    }

    const byKind = (k: string) => decided.filter(d => d.kind === k);
    return NextResponse.json({
      success: true,
      probe: 'route_kind_classify_v1',
      mode: apply ? 'apply' : 'dry-run',
      live_total: rows.length,
      would_set: { path: byKind('path').length, approach: byKind('approach').length },
      left_unset: unset,
      applied,
      // Первые из тех, кого признали «как добраться»: перед боевым прогоном
      // видно, кого именно уносит из каталога путей.
      approach_sample: byKind('approach').slice(0, 25).map(d => ({ id: d.id, title: d.title })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка разметки рода';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
