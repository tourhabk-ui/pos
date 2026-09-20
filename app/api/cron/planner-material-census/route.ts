/**
 * GET /api/cron/planner-material-census — чем планировщику наполнять дни.
 * Authorization: Bearer <CRON_SECRET>. READ-ONLY.
 *
 * ── ЗАЧЕМ ────────────────────────────────────────────────────────────────
 *
 * 19.09 перепись с прода нашла план из восьми одинаковых дней. Движок
 * наполняет день ОДНИМ из двух способов: тур оператора в этой зоне под эту
 * активность (`fetchRealToursForZone`) или маршрут той же пары
 * (`fetchRoutesForZone`). Не нашлось ни того, ни другого — остаётся общий
 * день без конкретики.
 *
 * Оба отбора требуют ОДНОВРЕМЕННОГО точного совпадения зоны и
 * `activity_type`. Живых туров восемь. Отсюда напрашивается правка
 * «ослабить activity_type, и дни наполнятся» — и делать её вслепую
 * нельзя: ослабишь, и в вулканический день ляжет рыболовный тур.
 * Обещание «вот ваш день на вулкане» с чужим содержимым хуже пустого дня.
 *
 * Поэтому сначала числа. Перепись считает по КАЖДОЙ паре «зона ×
 * активность» ровно теми предикатами, какими пользуется движок, и
 * показывает, какие пары пусты структурно, а какие — случайно. Решение об
 * ослаблении принимает владелец, по таблице, а не по правдоподобию.
 *
 * ── ЧЕГО ОНА НЕ ДЕЛАЕТ ───────────────────────────────────────────────────
 *
 * Ничего не чинит и не меняет: ни UPDATE, ни INSERT ни при каком аргументе.
 * Из «пара пуста» не следует, ЧТО с этим делать — завести тур, связать
 * маршрут с зоной или снять активность из планировщика. Выбор за человеком.
 *
 * ── ТРЕТЬЕ СОСТОЯНИЕ (§4.0) ──────────────────────────────────────────────
 *
 * Упавший запрос даёт `null` и строку в `errors`, а не ноль. Ноль значит
 * «спросили, пусто»; `null` — «спросить не вышло». Ровно та разница, из-за
 * которой пустой план 19.09 объяснялся сезоном недоказуемо.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
// Зоны и активности берутся из движка, а не переписываются здесь: свой
// список разошёлся бы с тем, по которому движок действительно ищет, и
// перепись отвечала бы про несуществующую платформу.
import { ACTIVITY_CONSTRAINTS, ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Пара «зона × активность» и чем её можно наполнить. */
export interface MaterialCell {
  zone: string;
  activity: string;
  /** Туров оператора — предикатами `fetchRealToursForZone`. */
  tours: number;
  /** Маршрутов — предикатами `fetchRoutesForZone`. */
  routes: number;
}

export interface PlannerMaterialCensus {
  ok: true;
  probe: 'planner_material_census_v1';
  measured_at: string;
  /** Непустые пары, по убыванию материала. `null` — запрос не выполнился. */
  cells: MaterialCell[] | null;
  /** Пары, где нечем наполнить день ВООБЩЕ. Это и есть общие дни в планах. */
  empty_pairs: string[] | null;
  /** Сколько пар рассмотрено всего — знаменатель для empty_pairs. */
  pairs_total: number;
  definitions: Record<string, string>;
  errors: string[];
}

const DEFINITIONS: PlannerMaterialCensus['definitions'] = {
  tours:
    'operator_tours + partners: ark.zone совпала (или зона avachinsky — там предикат движка ослаблен через OR), '
    + 'activity_type точно равен, is_active, is_published, deleted_at IS NULL, partners.is_public',
  routes:
    'agent_route_knowledge: zone и activity_type точно равны, is_visible, lat и lng не NULL',
  empty_pairs: 'пары, где и туров, и маршрутов ноль — день по ним собирается общим, без конкретики',
  pairs_total: 'число рассмотренных пар: зоны движка × активности с сезонным окном',
};

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const zones = Object.keys(ZONE_NAMES) as ZoneId[];
  const activities = Object.keys(ACTIVITY_CONSTRAINTS);
  const errors: string[] = [];

  // Обе выборки — ОДНИМ запросом каждая, с группировкой: шестьдесят с лишним
  // отдельных запросов ради той же таблицы были бы переписью, которая сама
  // нагружает то, что измеряет.
  let tourCounts: Map<string, number> | null = null;
  try {
    const { rows } = await pool.query<{ zone: string; activity: string; n: number }>(
      `SELECT COALESCE(ark.zone, 'avachinsky') AS zone,
              ot.activity_type                 AS activity,
              COUNT(*)::int                    AS n
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
         LEFT JOIN agent_route_knowledge ark ON ark.id = ot.agent_route_id
        WHERE ot.is_active = TRUE
          AND ot.is_published = TRUE
          AND ot.deleted_at IS NULL
          AND p.is_public = TRUE
        GROUP BY 1, 2`,
    );
    tourCounts = new Map(rows.map((r) => [`${r.zone}:${r.activity}`, r.n]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[planner-material-census] туры не посчитаны:', message);
    errors.push(`tours: ${message.slice(0, 160)}`);
  }

  let routeCounts: Map<string, number> | null = null;
  try {
    const { rows } = await pool.query<{ zone: string; activity: string; n: number }>(
      `SELECT zone, activity_type AS activity, COUNT(*)::int AS n
         FROM agent_route_knowledge
        WHERE is_visible = TRUE
          AND lat IS NOT NULL AND lng IS NOT NULL
          AND zone IS NOT NULL AND activity_type IS NOT NULL
        GROUP BY 1, 2`,
    );
    routeCounts = new Map(rows.map((r) => [`${r.zone}:${r.activity}`, r.n]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[planner-material-census] маршруты не посчитаны:', message);
    errors.push(`routes: ${message.slice(0, 160)}`);
  }

  // Не смогли прочитать хоть одну сторону — таблицы нет. Свести её из
  // половины значило бы назвать пары пустыми, не посмотрев на них.
  const measurable = tourCounts !== null && routeCounts !== null;

  const cells: MaterialCell[] = [];
  const emptyPairs: string[] = [];
  if (tourCounts !== null && routeCounts !== null) {
    for (const zone of zones) {
      for (const activity of activities) {
        const key = `${zone}:${activity}`;
        const tours = tourCounts.get(key) ?? 0;
        const routes = routeCounts.get(key) ?? 0;
        if (tours === 0 && routes === 0) {
          emptyPairs.push(`${ZONE_NAMES[zone]} / ${activity}`);
        } else {
          cells.push({ zone, activity, tours, routes });
        }
      }
    }
    cells.sort((a, b) => (b.tours + b.routes) - (a.tours + a.routes));
  }

  const body: PlannerMaterialCensus = {
    ok: true,
    probe: 'planner_material_census_v1',
    measured_at: new Date().toISOString(),
    cells: measurable ? cells : null,
    empty_pairs: measurable ? emptyPairs : null,
    pairs_total: zones.length * activities.length,
    definitions: DEFINITIONS,
    errors,
  };

  return NextResponse.json(body);
}
