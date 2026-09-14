/**
 * GET /api/cron/place-name-dups — одноимённые места, независимо от координат.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 14.09 владелец прислал десяток своих снимков, и на трёх местах подряд
 * выяснилось, что положить фото некуда однозначно: Курильское озеро лежит в
 * каталоге ДВУМЯ записями, Паужетские термальные источники — ЧЕТЫРЬМЯ, у
 * Кутхиных Батов точного id нет вовсе. Каждый раз снимок клался всем
 * одноимённым сразу — поштучно верно, по сути неправильно.
 *
 * ── Почему существующий дедуп этого не видит ──────────────────────────────
 *
 * `POST /api/cron/places-dedup` ищет дубли по БЛИЗОСТИ: пара отбирается, если
 * оба места лежат в окне ±0.02° по широте и ±0.03° по долготе, совпадает
 * `location_type` и похоже имя. Три условия из трёх требуют координат, и в
 * запросе прямо стоит `p1.lat IS NOT NULL AND p2.lat IS NOT NULL`.
 *
 * Значит пара, у которой хотя бы у одной записи координаты отсутствуют или
 * врут, не попадёт в отбор НИКОГДА — а это ровно тот случай, который и мешает
 * работать: если бы координаты у обеих были верны, вопрос «какая запись
 * живая» так остро не стоял бы.
 *
 * Перепись поэтому группирует по ИМЕНИ и о координатах не спрашивает вовсе.
 * Она не заменяет дедуп и не спорит с ним: тот чистит то, что видит, эта
 * показывает то, чего он не видит.
 *
 * ── Факт, а не приговор ───────────────────────────────────────────────────
 *
 * Вердикта «вот эта запись лишняя» здесь НЕТ, и это намеренно. Урок 23.08
 * (разбор одноимённых мест и маршрутов) стоил двадцати одной верной записи из
 * двадцати четырёх: самое сильное «согласие» в данных принадлежало ПРАВИЛЬНОЙ
 * записи, и автомат испортил бы больше, чем починил. Тёзки существуют:
 * «Видовая точка на горе Верблюд» и «Видовая точка на горе Верблюд (нижняя)» —
 * два разных места с почти одним именем.
 *
 * Поэтому по каждому участнику кластера сообщается СОСТАВ: есть ли координата,
 * фото, профиль безопасности, видима ли запись, слита ли она уже. Решение
 * человека, и принимать его по этим полям можно, а по одному имени — нет.
 *
 * READ-ONLY. Ни UPDATE, ни INSERT, ни DELETE ни при каком аргументе.
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface MemberRow {
  norm_name: string;
  id: string;
  ark_id: string | null;
  name: string;
  location_type: string | null;
  is_visible: boolean | null;
  merged_into_id: string | null;
  has_coords: boolean;
  has_photo: boolean;
  has_safety: boolean;
  created_at: string | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Нормализация имени — регистр, края, схлопнутые пробелы. Ровно та же,
    // что у контент-дедупа алертов (seismic-parser.saveEvent): одно правило на
    // платформу, чтобы «Паужетские  источники» и «паужетские источники» не
    // считались разными именами, а по-настоящему разные имена не слипались.
    const { rows } = await pool.query<MemberRow>(
      `WITH normed AS (
         SELECT p.id::text AS id,
                p.ark_id::text AS ark_id,
                p.name,
                regexp_replace(lower(trim(p.name)), '\\s+', ' ', 'g') AS norm_name,
                p.location_type,
                p.is_visible,
                p.merged_into_id::text AS merged_into_id,
                (p.lat IS NOT NULL AND p.lng IS NOT NULL
                 AND NOT (p.lat = 0 AND p.lng = 0))              AS has_coords,
                p.created_at::text AS created_at
           FROM places p
          WHERE p.name IS NOT NULL AND trim(p.name) <> ''
       ),
       dup_names AS (
         SELECT norm_name
           FROM normed
          GROUP BY norm_name
         HAVING COUNT(*) > 1
       )
       SELECT n.norm_name, n.id, n.ark_id, n.name, n.location_type,
              n.is_visible, n.merged_into_id, n.has_coords, n.created_at,
              (ari.route_id IS NOT NULL) AS has_photo,
              (lsp.agent_route_id IS NOT NULL) AS has_safety
         FROM normed n
         JOIN dup_names d ON d.norm_name = n.norm_name
         LEFT JOIN ai_route_images ari ON ari.route_id::text = n.ark_id
         LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id::text = n.ark_id
        ORDER BY n.norm_name, n.created_at NULLS LAST, n.id`
    );

    // Общее число мест — чтобы кластеры читались долей, а не голым числом.
    const { rows: totalRows } = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM places WHERE name IS NOT NULL AND trim(name) <> ''`
    );
    const placesTotal = totalRows[0]?.total ?? 0;

    const byName = new Map<string, MemberRow[]>();
    for (const r of rows) {
      const list = byName.get(r.norm_name) ?? [];
      list.push(r);
      byName.set(r.norm_name, list);
    }

    const clusters = [...byName.entries()].map(([norm, members]) => {
      // «Живой» здесь значит только «не слита и не скрыта» — это состояние
      // записи, а не суждение о том, какая из них правильная.
      const live = members.filter((rec) => rec.merged_into_id === null && rec.is_visible !== false);
      return {
        name: norm,
        members_total: members.length,
        live_total: live.length,
        already_merged: members.filter((rec) => rec.merged_into_id !== null).length,
        hidden: members.filter((rec) => rec.is_visible === false).length,
        // Сколько живых записей несут хоть что-то. Ноль у всех живых — кластер,
        // где выбирать не из чего, и это другая работа, чем выбор из двух
        // наполненных.
        live_with_coords: live.filter((rec) => rec.has_coords).length,
        live_with_photo: live.filter((rec) => rec.has_photo).length,
        live_with_safety: live.filter((rec) => rec.has_safety).length,
        // Разные типы под одним именем — сильный признак, что это РАЗНЫЕ
        // объекты, а не дубль: озеро и смотровая площадка могут зваться
        // одинаково.
        distinct_types: [...new Set(members.map((rec) => rec.location_type ?? 'null'))],
        members: members.map((rec) => ({
          id: rec.id,
          ark_id: rec.ark_id,
          name: rec.name,
          location_type: rec.location_type,
          is_visible: rec.is_visible,
          merged_into_id: rec.merged_into_id,
          has_coords: rec.has_coords,
          has_photo: rec.has_photo,
          has_safety: rec.has_safety,
          created_at: rec.created_at,
        })),
      };
    });

    // Сортировка по числу ЖИВЫХ записей: кластер из четырёх живых стоит
    // разбора раньше, чем из четырёх, где три уже слиты.
    clusters.sort((a, b) => b.live_total - a.live_total || b.members_total - a.members_total);

    const needsDecision = clusters.filter((c) => c.live_total > 1);
    // Невидимый дедупу — тот, где хотя бы одна живая запись без координат:
    // places-dedup такую пару не отберёт ни при каком пороге.
    const invisibleToDedup = needsDecision.filter((c) => c.live_with_coords < c.live_total);

    return NextResponse.json({
      success: true,
      places_total: placesTotal,
      clusters_total: clusters.length,
      // Главное число: сколько имён, под которыми ПРЯМО СЕЙЧАС больше одной
      // живой записи. Остальные кластеры уже разобраны — слиты или скрыты.
      clusters_needing_decision: needsDecision.length,
      places_in_those_clusters: needsDecision.reduce((s, c) => s + c.live_total, 0),
      // Сколько из них существующий дедуп не увидит по построению.
      clusters_invisible_to_dedup: invisibleToDedup.length,
      clusters: needsDecision,
      note:
        'Перепись сообщает состав кластера, а не вердикт: одноимённость — не доказательство дубля. ' +
        'Разные location_type под одним именем чаще означают разные объекты. Решение человека.',
    });
  } catch (err) {
    // Отказ не глушится: имя проверки и сообщение в ответе, чтобы «не смогли»
    // не читалось как «дублей нет» (§4.0).
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: `place-name-dups: перепись не выполнена — ${message}` },
      { status: 502 },
    );
  }
}
