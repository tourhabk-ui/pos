/**
 * GET /api/cron/safety-profile-census — сколько опасностей мест выдумано.
 * Bearer CRON_SECRET, только чтение, ничего не меняет.
 *
 * ЗАЧЕМ. Слой безопасности мест завела миграция 070 (близнец — 0645) одним
 * запросом по всем записям, выводя значения из `location_type`: вулкан —
 * «лавины, камнепад, термальные, высота», сложность 4, лимит 30 человек в
 * сутки; горячий источник — «термальные, химические», лимит 100. Ни одно из
 * этих значений не измерено, а карточка места печатала их как факты рядом с
 * высотой и расстоянием до медпомощи, и Кузьмич проговаривал словами.
 *
 * Цену уже платили поимённо: миграции 972-974 снимали с Сопки Никольской —
 * стометрового холма с городским парком в центре Петропавловска — лавины,
 * камнепад, термальные поля и высотную болезнь. 992 — то же для Перевала
 * Сноубордистов. Сколько таких записей ОСТАЛОСЬ, не знал никто: цифры не
 * существовало, а обход экранов 26.09 мог только показать механизм.
 *
 * Миграция 1036 записала происхождение строки в `profile_source`. Перепись
 * его СЧИТАЕТ и больше ничего не делает: вердикт «пора размечать вручную»
 * выносит человек, сравнив числа.
 *
 * ЧЕГО ПЕРЕПИСЬ НЕ ДЕЛАЕТ — и не делает вид, что делает.
 *
 * Она не выводит происхождение заново из данных. Отпечаток шаблона сверяла
 * миграция один раз, при разметке; повторять сверку здесь значило бы завести
 * второе правило о том же (§12: правило, написанное дважды, — это два
 * правила, и они расходятся). Строка с `profile_source IS NULL` называется
 * честно: источник не записан.
 *
 * Она не утверждает, что `unknown` — это правда. Там лишь известно, что
 * шаблон эту строку не писал целиком: хотя бы одно поле отличается.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { SAFETY_PROFILE_SOURCES } from '@/lib/safety/profile-source';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

interface SourceRow { profile_source: string | null; cnt: string }
interface HazardRow { hazard_set: string | null; cnt: string; visible_places: string }
interface CrowdRow { measured: string; not_measured: string; rows_total: string }

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [bySource, byHazardSet, crowds] = await Promise.all([
      pool.query<SourceRow>(
        `SELECT lsp.profile_source, COUNT(*)::text AS cnt
           FROM location_safety_profile lsp
          GROUP BY lsp.profile_source
          ORDER BY COUNT(*) DESC`,
      ),
      // Набор опасностей плюс сколько за ним ЖИВЫХ мест: шаблон виден
      // глазами, а вес находки — числом видимых карточек, а не строк таблицы.
      pool.query<HazardRow>(
        `SELECT array_to_string(lsp.hazard_types, ',') AS hazard_set,
                COUNT(*)::text AS cnt,
                COUNT(*) FILTER (
                  WHERE EXISTS (
                    SELECT 1 FROM places p
                     WHERE p.ark_id = lsp.agent_route_id
                       AND p.is_visible = TRUE
                       AND p.merged_into_id IS NULL
                  )
                )::text AS visible_places
           FROM location_safety_profile lsp
          WHERE lsp.profile_source = 'type_template'
          GROUP BY 1
          ORDER BY COUNT(*) DESC
          LIMIT 20`,
      ),
      // Загрузка: производителя у колонки нет ни одного. Число «измерено»
      // обязано быть нулём, пока производитель не появится, — и если оно
      // вдруг не ноль, это важнее любой другой строки переписи.
      pool.query<CrowdRow>(
        `SELECT COUNT(*) FILTER (WHERE current_crowds IS NOT NULL)::text AS measured,
                COUNT(*) FILTER (WHERE current_crowds IS NULL)::text     AS not_measured,
                COUNT(*)::text                                            AS rows_total
           FROM location_real_time_status`,
      ),
    ]);

    const counts: Record<string, number> = {};
    for (const s of SAFETY_PROFILE_SOURCES) counts[s] = 0;
    let sourceNotRecorded = 0;
    for (const r of bySource.rows) {
      const n = Number(r.cnt);
      if (r.profile_source === null) sourceNotRecorded = n;
      else counts[r.profile_source] = (counts[r.profile_source] ?? 0) + n;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0) + sourceNotRecorded;

    return NextResponse.json({
      ok: true,
      checked_at: new Date().toISOString(),
      profiles_total: total,
      by_source: counts,
      /** Строк, которым миграция 1038 источник не присвоила: места нет в agent_route_knowledge. */
      source_not_recorded: sourceNotRecorded,
      template_hazard_sets: byHazardSet.rows.map((r) => ({
        hazards: r.hazard_set === '' ? null : r.hazard_set,
        profiles: Number(r.cnt),
        visible_places: Number(r.visible_places),
      })),
      crowds: {
        measured: Number(crowds.rows[0]?.measured ?? '0'),
        not_measured: Number(crowds.rows[0]?.not_measured ?? '0'),
        rows_total: Number(crowds.rows[0]?.rows_total ?? '0'),
        note: 'Производителя у current_crowds в платформе нет: measured > 0 означает, что он появился и об этом надо знать.',
      },
    });
  } catch (err) {
    // Отказ переписи — это «не смог посчитать», а не «выдумок нет» (§4.0).
    const e = err as { code?: string; message?: string };
    console.error('[safety-profile-census] перепись не выполнилась', {
      sqlstate: e?.code,
      message: e?.message,
    });
    return NextResponse.json(
      { ok: false, error: 'Перепись не выполнилась', sqlstate: e?.code ?? null },
      { status: 500 },
    );
  }
}
