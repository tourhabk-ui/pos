/**
 * POST /api/cron/routes-dedup — мягкое слияние маршрутов-дублей.
 *
 * Bearer CRON_SECRET. Body: { pairs: [{keep, merge}], dry_run (default true) }.
 * ТОЛЬКО поимённый режим — авто-режима нет и не будет (конструкция
 * обсуждена с владельцем 15.08, правила — lib/routes/dedup.ts).
 *
 * Сухой прогон возвращает план с фактами по каждой паре (геометрия, туры,
 * паспорт) и предупреждениями. Боевой — транзакция на пару:
 *   1. настоящий трек дубля переезжает, если keep без настоящего;
 *   2. route_waypoints перевешиваются без дублей, остаток удаляется;
 *   3. operator_tours.route_id перевешивается (warning на каждый);
 *   4. паспортные поля НЕ переносятся (warning при наличии);
 *   5. merged_into_id + merged_at; VIEW (869) скрывает слитое с витрины.
 *
 * Откат — POST /api/cron/routes-unmerge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import {
  pairListProblems, pairWarnings, shouldAdoptGeometry, planFieldTransfer, TRANSFER_FIELDS,
  type GeometryInfo, type PairFacts, type FieldTransferPlan,
} from '@/lib/routes/dedup';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  pairs: z.array(z.object({
    keep: z.string().min(8).max(64),
    merge: z.string().min(8).max(64),
  })).min(1).max(50),
});

interface RouteRow {
  given_keep: string; given_merge: string;
  keep_id: string | null; keep_title: string | null; keep_merged: string | null;
  keep_geom_present: boolean; keep_geom_source: string | null;
  merge_id: string | null; merge_title: string | null; merge_merged: string | null;
  merge_geom_present: boolean; merge_geom_source: string | null;
  merge_tours: number; merge_passport: boolean;
  /** keep_f_<col> / merge_f_<col> — значения переносимых полей текстом. */
  [key: string]: unknown;
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  const problems = pairListProblems(data.pairs);

  try {
    // Сравнение id ТОЛЬКО как текст — тип чужой колонки не предполагаем
    // (урок places-dedup: ::uuid[] упал на TEXT-колонке прода).
    const { rows } = await pool.query<RouteRow>(
      `SELECT t.keep AS given_keep, t.merge AS given_merge,
              k.id::text AS keep_id, k.title AS keep_title, k.merged_into_id AS keep_merged,
              (k.geometry IS NOT NULL) AS keep_geom_present,
              k.geometry->>'source' AS keep_geom_source,
              m.id::text AS merge_id, m.title AS merge_title, m.merged_into_id AS merge_merged,
              (m.geometry IS NOT NULL) AS merge_geom_present,
              m.geometry->>'source' AS merge_geom_source,
              (SELECT COUNT(*)::int FROM operator_tours ot WHERE ot.route_id::text = m.id::text) AS merge_tours,
              (m.pdf_url IS NOT NULL OR m.mchs_phone IS NOT NULL) AS merge_passport,
              -- Значения переносимых полей ОБЕИХ записей одним видом (::text):
              -- решение принимается в TS (planFieldTransfer), а не пятью
              -- разными сравнениями по типам внутри SQL.
              k.pdf_url ::text AS keep_f_pdf_url, m.pdf_url ::text AS merge_f_pdf_url,
              k.source_url ::text AS keep_f_source_url, m.source_url ::text AS merge_f_source_url,
              k.mchs_phone ::text AS keep_f_mchs_phone, m.mchs_phone ::text AS merge_f_mchs_phone,
              k.mchs_registration_required ::text AS keep_f_mchs_registration_required, m.mchs_registration_required ::text AS merge_f_mchs_registration_required,
              k.registration_required ::text AS keep_f_registration_required, m.registration_required ::text AS merge_f_registration_required,
              k.park_name ::text AS keep_f_park_name, m.park_name ::text AS merge_f_park_name,
              k.park_approval_url ::text AS keep_f_park_approval_url, m.park_approval_url ::text AS merge_f_park_approval_url,
              k.hazards ::text AS keep_f_hazards, m.hazards ::text AS merge_f_hazards,
              k.equipment ::text AS keep_f_equipment, m.equipment ::text AS merge_f_equipment,
              k.description ::text AS keep_f_description, m.description ::text AS merge_f_description,
              k.distance_km ::text AS keep_f_distance_km, m.distance_km ::text AS merge_f_distance_km,
              k.elevation_gain_m ::text AS keep_f_elevation_gain_m, m.elevation_gain_m ::text AS merge_f_elevation_gain_m,
              k.duration_hours ::text AS keep_f_duration_hours, m.duration_hours ::text AS merge_f_duration_hours,
              k.season ::text AS keep_f_season, m.season ::text AS merge_f_season,
              k.route_type ::text AS keep_f_route_type, m.route_type ::text AS merge_f_route_type,
              k.flora_fauna ::text AS keep_f_flora_fauna, m.flora_fauna ::text AS merge_f_flora_fauna,
              k.accessibility ::text AS keep_f_accessibility, m.accessibility ::text AS merge_f_accessibility
       FROM unnest($1::text[], $2::text[]) AS t(keep, merge)
       LEFT JOIN kamchatka_routes k ON k.id::text = t.keep
       LEFT JOIN kamchatka_routes m ON m.id::text = t.merge`,
      [data.pairs.map(p => p.keep), data.pairs.map(p => p.merge)],
    );

    interface PlanItem {
      keepId: string; keepTitle: string; mergeId: string; mergeTitle: string;
      adoptGeometry: boolean; mergeTours: number; warnings: string[];
      /** Что доносится до keep и что осталось решать человеку. */
      transfer: FieldTransferPlan;
    }

    /** Значения переносимых полей одной стороны — из плоской строки ответа. */
    const sideValues = (r: RouteRow, side: 'keep' | 'merge'): Record<string, string | null> =>
      Object.fromEntries(TRANSFER_FIELDS.map(f => [f.col, (r[`${side}_f_${f.col}`] as string | null) ?? null]));
    const plan: PlanItem[] = [];

    for (const r of rows) {
      if (!r.keep_id) { problems.push(`${r.given_keep}: маршрута с таким id нет`); continue; }
      if (!r.merge_id) { problems.push(`${r.given_merge}: маршрута с таким id нет`); continue; }
      if (r.keep_merged) { problems.push(`${r.keep_title}: уже слит в другой маршрут`); continue; }
      if (r.merge_merged) { problems.push(`${r.merge_title}: уже слит в другой маршрут`); continue; }

      const keepG: GeometryInfo = { present: r.keep_geom_present, source: r.keep_geom_source };
      const mergeG: GeometryInfo = { present: r.merge_geom_present, source: r.merge_geom_source };
      const transfer = planFieldTransfer(sideValues(r, 'keep'), sideValues(r, 'merge'));
      const facts: PairFacts = {
        keepName: r.keep_title ?? '', mergeName: r.merge_title ?? '',
        keepGeometry: keepG, mergeGeometry: mergeG,
        mergeTours: r.merge_tours, mergeHasPassport: r.merge_passport,
        transfer,
      };
      plan.push({
        keepId: r.keep_id, keepTitle: r.keep_title ?? '',
        mergeId: r.merge_id, mergeTitle: r.merge_title ?? '',
        adoptGeometry: shouldAdoptGeometry(keepG, mergeG),
        mergeTours: r.merge_tours,
        transfer,
        warnings: pairWarnings(facts),
      });
    }

    if (problems.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Пары не прошли проверку — не слито ничего', problems },
        { status: 400 },
      );
    }

    if (data.dry_run) {
      return NextResponse.json({ success: true, dry_run: true, candidate_total: plan.length, plan });
    }

    const merged: Array<{ keep: string; merge: string; warnings: string[] }> = [];
    // Пропуски переноса, обнаруженные уже в транзакции: в план они попасть
    // не могли — там keep ещё был пуст.
    const transferSkipped: string[] = [];
    for (const p of plan) {
      // eslint-disable-next-line no-await-in-loop
      await transaction(async (client) => {
        if (p.adoptGeometry) {
          await client.query(
            `UPDATE kamchatka_routes k
             SET geometry = m.geometry, updated_at = NOW()
             FROM kamchatka_routes m
             WHERE k.id::text = $1 AND m.id::text = $2 AND m.geometry IS NOT NULL`,
            [p.keepId, p.mergeId],
          );
        }
        // Перенос полей ДО перевешивания связей: заливаются только те
        // колонки, где у keep пусто (plan.transfer.fill посчитан на чтении).
        // Перезаписи быть не может по построению — список составлен из
        // пустых у keep, — но WHERE ещё раз требует пустоты на момент
        // записи: между чтением и транзакцией keep мог заполниться.
        if (p.transfer.fill.length > 0) {
          const cols = p.transfer.fill.map(f => f.col);
          const sets = cols.map(c => `${c} = m.${c}`).join(', ');
          // Сторож пустоты — ПО ТИПУ колонки. Первая редакция писала везде
          // `IS NULL`, и пустой массив (`{}` — не NULL) провалил бы условие:
          // при ANDе одна колонка отменила бы перенос всех остальных молча.
          // Тип берётся из реестра, а не угадывается по имени (урок btrim).
          const guards = cols.map((c) => {
            const kind = TRANSFER_FIELDS.find(f => f.col === c)?.kind ?? 'scalar';
            if (kind === 'text') return `(k.${c} IS NULL OR btrim(k.${c}) = '')`;
            if (kind === 'array') return `(k.${c} IS NULL OR cardinality(k.${c}) = 0)`;
            return `k.${c} IS NULL`;
          }).join(' AND ');
          const res = await client.query(
            `UPDATE kamchatka_routes k
                SET ${sets}, updated_at = NOW()
               FROM kamchatka_routes m
              WHERE k.id::text = $1 AND m.id::text = $2 AND (${guards})`,
            [p.keepId, p.mergeId],
          );
          // Ноль строк при непустом списке — keep успел заполниться между
          // чтением плана и записью. Перенос не состоялся, и сказать об этом
          // обязательно: молчание здесь неотличимо от «всё перенесли».
          if (res.rowCount === 0) {
            transferSkipped.push(
              `${p.mergeTitle}: перенос полей не состоялся — «${p.keepTitle}» изменился между планом и записью, поля остались на дубле`,
            );
          }
        }
        await client.query(
          `UPDATE route_waypoints rw SET route_id = (SELECT id FROM kamchatka_routes WHERE id::text = $1)
           WHERE rw.route_id::text = $2
             AND NOT EXISTS (
               SELECT 1 FROM route_waypoints rw2
               WHERE rw2.route_id::text = $1 AND rw2.place_id = rw.place_id
             )`,
          [p.keepId, p.mergeId],
        );
        await client.query(`DELETE FROM route_waypoints WHERE route_id::text = $1`, [p.mergeId]);
        await client.query(
          `UPDATE operator_tours SET route_id = (SELECT id FROM kamchatka_routes WHERE id::text = $1)
           WHERE route_id::text = $2`,
          [p.keepId, p.mergeId],
        );
        await client.query(
          `UPDATE kamchatka_routes SET merged_into_id = $1, merged_at = NOW()
           WHERE id::text = $2 AND merged_into_id IS NULL`,
          [p.keepId, p.mergeId],
        );
      });
      merged.push({ keep: p.keepTitle, merge: p.mergeTitle, warnings: p.warnings });
    }

    return NextResponse.json({
      success: true, dry_run: false, merged_count: merged.length, merged,
      // Пустой список — переносы прошли. Непустой означает, что часть полей
      // осталась на скрытой записи, и это надо разобрать глазами.
      transfer_skipped: transferSkipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка дедупа маршрутов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
