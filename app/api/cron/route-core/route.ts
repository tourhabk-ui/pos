/**
 * GET /api/cron/route-core?secret=<CRON_SECRET>[&size=20]
 *
 * Ф5 плана наведения порядка в маршрутах (.claude/ROUTES_ORDER_PLAN.md):
 * именованный список ядра. Правило готово с 21.08 (lib/routes/error-cost.ts),
 * сам список — единственный названный вслух долг фазы («Не сделано: сам
 * список из двадцати») — собирается здесь.
 *
 * ПОЧЕМУ НЕ ПО СПРОСУ. Первая редакция Ф5 требовала порядок «по фактическим
 * открытиям карточек». Замер 19.08 показал у самой популярной записи ШЕСТЬ
 * открытий и ОДИН посетитель — сортировать такую разницу значит сортировать
 * шум. Решение владельца 21.08: ядро — это «где ошибиться дороже всего»
 * (МЧС обязательна / нет оператора-проводника / опасности названы либо не
 * проверялись / природный парк). Правило и его порядок сравнения — целиком в
 * error-cost.ts; здесь только сбор входа и вызов.
 *
 * ПОЧЕМУ ВЕРДИКТ СЧИТАЕТСЯ УПРОЩЁННО, А НЕ ПОЛНЫМ АУДИТОМ. Тот же приём, что
 * в route-popularity.ts: этот список отвечает на вопрос «что размечать
 * вручную дальше», а не «сходятся ли данные» — на второе отвечает еженедельная
 * перепись (/api/cron/route-data-audit). Заводить здесь второй тяжёлый обход
 * значило бы дублировать census дважды в неделю ради одного и того же ответа.
 *
 * ЧЕГО ЭТОТ СПИСОК НЕ ДЕЛАЕТ. Не выдумывает срок годности. План прямо
 * запрещает угадывать интервал пересмотра: «универсальный срок годности не
 * выдумывается, интервалы назначаются после того, как перепись их измерит».
 * Ни разу для этих 20 записей пересмотр ещё не проводился — значит
 * `next_review_due` и `verified_by` честно `null` со словами, а не датой,
 * взятой с потолка.
 *
 * READ-ONLY. Персональных данных нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { routeNavigability } from '@/lib/routes/navigability';
import { detectTravelMode } from '@/lib/routes/travel-mode';
import { asLinkKind, isPathPoint } from '@/lib/routes/link-kind';
import { geometryToTrack } from '@/lib/routes/geometry-audit';
import { whatIsMissing } from '@/lib/routes/popularity';
import { buildCore, type ErrorCostInput } from '@/lib/routes/error-cost';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Версия формы ответа — см. соглашение route-popularity.ts (POPULARITY_VERSION). */
export const ROUTE_CORE_VERSION = 1;

const DEFAULT_SIZE = 20;
const MAX_SIZE = 50;

interface RouteRow {
  id: string;
  title: string | null;
  geometry: unknown;
  mchs_registration_required: boolean | null;
  hazards: string[] | null;
  park_name: string | null;
  kinds: string[] | null;
  waypoints: string;
  tours: string;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', v: ROUTE_CORE_VERSION }, { status: 401 });
  }

  const rawSize = parseInt(request.nextUrl.searchParams.get('size') ?? String(DEFAULT_SIZE), 10);
  const size = Math.min(Math.max(Number.isFinite(rawSize) ? rawSize : DEFAULT_SIZE, 1), MAX_SIZE);
  const startedAt = Date.now();

  try {
    const { rows } = await pool.query<RouteRow>(
      `SELECT r.id::text, r.title, r.geometry,
              r.mchs_registration_required, r.hazards, r.park_name,
              ARRAY_REMOVE(ARRAY_AGG(to_jsonb(rw)->>'link_kind'), NULL) AS kinds,
              COUNT(rw.id)::text AS waypoints,
              (SELECT COUNT(*)::text FROM operator_tours t WHERE t.route_id = r.id) AS tours
         FROM kamchatka_routes r
         LEFT JOIN route_waypoints rw ON rw.route_id = r.id
        WHERE (r.is_visible = TRUE OR r.is_visible IS NULL)
          AND r.merged_into_id IS NULL
        GROUP BY r.id, r.title, r.geometry,
                 r.mchs_registration_required, r.hazards, r.park_name`,
    );

    // Для «чего не хватает» нужны pathPoints/hasLine — они не входят в
    // ErrorCostInput (цена ошибки их не спрашивает), поэтому карта рядом,
    // а не поля, прицепленные к чужому типу.
    const missingFacts = new Map<string, { pathPoints: number; hasLine: boolean }>();

    const inputs: ErrorCostInput[] = rows.map((r) => {
      const track = geometryToTrack(r.geometry);
      const pairs = track.map((p) => [p.lat, p.lng] as [number, number]);
      const kinds = (r.kinds ?? []).map(asLinkKind);
      const pathPoints = kinds.length > 0 ? kinds.filter(isPathPoint).length : Number(r.waypoints);
      const nav = routeNavigability({
        grade: pairs.length >= 2 ? 'unknown' : 'points_only',
        track: pairs.length >= 2 ? pairs : null,
        waypoints: [],
        mode: detectTravelMode(r.title),
      });
      missingFacts.set(r.id, { pathPoints, hasLine: pairs.length >= 2 });
      return {
        id: r.id,
        title: r.title ?? '(без названия)',
        mchsRequired: r.mchs_registration_required ?? false,
        hazards: r.hazards,
        tours: Number(r.tours),
        parkName: r.park_name,
        verdict: nav.verdict,
      };
    });

    const core = buildCore(inputs, size).map((row) => {
      const facts = missingFacts.get(row.id) ?? { pathPoints: 0, hasLine: false };
      return {
        id: row.id,
        title: row.title,
        signals: row.signals,
        why: row.why,
        // Что уже проверено электронно — те самые четыре признака, из
        // которых состоит why: по ним и решали, что запись здесь.
        checked: {
          mchs_required: row.mchsRequired,
          hazards_state: row.hazards === null ? 'unknown' : row.hazards.length > 0 ? 'listed' : 'none',
          unguided: row.unguided,
          park_name: row.parkName,
        },
        verdict: row.verdict,
        missing: whatIsMissing({ verdict: row.verdict, waypoints: facts.pathPoints, hasLine: facts.hasLine }),
        // Честно null: план запрещает угадывать интервал, а первый разбор
        // этой записи ядра ещё не проводился никем.
        next_review_due: null,
        verified_by: null,
      };
    });

    return NextResponse.json({
      success: true,
      v: ROUTE_CORE_VERSION,
      probe: 'route_core_v1',
      rule: 'lib/routes/error-cost.ts — цена ошибки, не спрос (решение владельца 21.08)',
      routes_considered: rows.length,
      size,
      core,
      review_note:
        'next_review_due и verified_by — null у всех записей: план запрещает выдумывать ' +
        'срок годности, а первый ручной разбор этого списка ещё не проводился. ' +
        'Дата и источник появятся после того, как кто-то реально проверит запись.',
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Ядро не собрано' },
      { status: 500 },
    );
  }
}
