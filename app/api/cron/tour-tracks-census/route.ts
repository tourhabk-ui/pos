/**
 * GET /api/cron/tour-tracks-census — у каких туров операторов нет линии.
 *
 * Основа письма операторам за GPX (решение владельца 20.08): просить трек
 * имеет смысл только там, где его нет, и просить конкретно — «по туру X
 * маршрут не привязан», «по туру Y маршрут есть, но линии нет», а не
 * «пришлите что-нибудь». Для каждого живого тура: оператор, маршрут,
 * есть ли у маршрута геометрия и какого она рода (source).
 *
 * Род линии здесь не пересуживается — печатается сырой source; чем судить
 * (track/sketch/unknown), решает lib/map/line-standard на витрине.
 *
 * Блок place_link (аудит 15.10, TOUR-PLACE) — охват связи «тур → место» у
 * ЖИВЫХ туров (шлюз витрины publicTourSql, без черновиков): сколько связаны
 * маршрутом (route_id), сколько главным местом (main_place_id, 1286) и
 * откуда эта связь, сколько не связаны ничем — поимённо, id и название тура
 * с вывеской оператора, без контактов. Такой тур не попадает ни в «Туры
 * сюда» на карточке места, ни в китайские конспекты мест. Отказ этого
 * блока — null с причиной, а не ноль (§4.0): верхняя часть переписи от него
 * не зависит.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface PlaceLinkRow {
  tour_id: string;
  tour_title: string;
  operator_name: string | null;
  has_route: boolean;
  main_place_id: string | null;
  main_place_source: string | null;
  /** Главное место видно на витрине (не скрыто и не слито). */
  main_place_shown: boolean | null;
}

/** Охват связи «тур → место» у живых туров; null — не прочиталось (причина в логе). */
async function placeLinkCensus(): Promise<{ block: Record<string, unknown> | null; error: string | null }> {
  try {
    const { rows } = await pool.query<PlaceLinkRow>(
      `SELECT t.id::text AS tour_id, t.title AS tour_title,
              p.name AS operator_name,
              (r.id IS NOT NULL) AS has_route,
              t.main_place_id,
              t.main_place_source,
              CASE WHEN t.main_place_id IS NULL THEN NULL
                   ELSE (pl.is_visible = TRUE AND pl.merged_into_id IS NULL) END AS main_place_shown
       FROM operator_tours t
       LEFT JOIN partners p ON p.id = t.operator_id
       LEFT JOIN kamchatka_routes r
         ON r.id = t.route_id AND r.merged_into_id IS NULL
       LEFT JOIN places pl ON pl.id = t.main_place_id
       WHERE ${publicTourSql('t')}
       ORDER BY p.name NULLS LAST, t.title`,
    );
    const withMain = rows.filter(r => r.main_place_id !== null);
    const bySource: Record<string, number> = {};
    for (const r of withMain) {
      const k = r.main_place_source ?? 'не записан';
      bySource[k] = (bySource[k] ?? 0) + 1;
    }
    const unlinked = rows.filter(r => !r.has_route && r.main_place_id === null);
    return {
      error: null,
      block: {
        scope: 'живые туры: is_active, is_published, не удалены (publicTourSql)',
        live_total: rows.length,
        with_route: rows.filter(r => r.has_route).length,
        with_main_place: withMain.length,
        main_place_by_source: bySource,
        main_place_not_shown: withMain.filter(r => r.main_place_shown === false).length,
        with_both: rows.filter(r => r.has_route && r.main_place_id !== null).length,
        unlinked: unlinked.length,
        unlinked_items: unlinked.map(r => ({ tour_id: r.tour_id, tour_title: r.tour_title, operator_name: r.operator_name })),
      },
    };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[tour-tracks-census] place_link не прочитан:', `sqlstate=${typeof code === 'string' ? code : 'нет'}`, message);
    return { block: null, error: `place_link не прочитан: ${typeof code === 'string' ? `SQLSTATE ${code}` : message}` };
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      tour_id: string; tour_title: string; operator_name: string | null;
      route_id: string | null; route_title: string | null;
      has_line: boolean | null; geometry_source: string | null;
    }>(
      `SELECT t.id::text AS tour_id, t.title AS tour_title,
              p.name AS operator_name,
              r.id::text AS route_id, r.title AS route_title,
              CASE WHEN r.id IS NULL THEN NULL ELSE (r.geometry IS NOT NULL) END AS has_line,
              r.geometry->>'source' AS geometry_source
       FROM operator_tours t
       LEFT JOIN partners p ON p.id = t.operator_id
       LEFT JOIN kamchatka_routes r
         ON r.id = t.route_id AND r.merged_into_id IS NULL
       WHERE t.deleted_at IS NULL
       ORDER BY p.name NULLS LAST, t.title`,
    );

    // Три судьбы тура — и у каждой свой абзац в письме:
    //   no_route  — маршрут не привязан вовсе: не знаем, куда он ведёт;
    //   no_line   — маршрут есть, линии нет: GPX ляжет сразу;
    //   has_line  — линия есть (родом какая есть) — просить нечего.
    const noRoute = rows.filter(r => r.route_id === null);
    const noLine = rows.filter(r => r.route_id !== null && r.has_line === false);
    const hasLine = rows.filter(r => r.has_line === true);
    const placeLink = await placeLinkCensus();

    return NextResponse.json({
      success: true,
      probe: 'tour_tracks_v1',
      tours_total: rows.length,
      no_route: noRoute.length,
      no_line: noLine.length,
      has_line: hasLine.length,
      items: rows,
      place_link: placeLink.block,
      ...(placeLink.error ? { place_link_error: placeLink.error } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи треков туров';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
