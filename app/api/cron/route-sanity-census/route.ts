/**
 * GET /api/cron/route-sanity-census — перепись противоречий внутри записей
 * маршрутов. Bearer CRON_SECRET, ТОЛЬКО ЧТЕНИЕ.
 *
 * ── Зачем отдельно от разбора корпуса ─────────────────────────────────────
 *
 * `route-analysis` показывает корпус модели целиком и стоит ~600 ₽ за проход;
 * он нужен для того, что видно только между записями (дубли, чужие путевые
 * точки, тёзки). Но пять из тридцати трёх его находок 07.09 были ШКОЛЬНОЙ
 * АРИФМЕТИКОЙ: 80 км разделить на 4 часа. Такое не должно стоить прогона и
 * не должно ждать следующего.
 *
 * Здесь то же самое считает `lib/routes/route-contradiction` — детерминированно,
 * бесплатно и на каждом запросе. Своих порогов перепись не заводит: судья один.
 *
 * ── Ничего не чинит ───────────────────────────────────────────────────────
 *
 * Из «80 км за 4 часа» не следует, какое из двух чисел неверно: могли смешать
 * пеший участок с трансфером, и тогда неверно всё описание. Выбор правды —
 * решение человека, перепись только показывает, что правды в записи нет.
 *
 * Ответ содержит `unchecked_total` намеренно: запись, которую судить НЕ ВЫШЛО
 * (нет длины, нет описания), не считается благополучной (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { judgeRoute, type ContradictionKind } from '@/lib/routes/route-contradiction';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Row {
  id: string;
  title: string;
  description: string | null;
  activity_type: string | null;
  season: string | null;
  distance_km: string | null;
  duration_hours: string | null;
  elevation_gain_m: number | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT r.id::text AS id,
              r.title,
              r.description,
              r.activity_type,
              r.season,
              r.distance_km::text,
              r.duration_hours::text,
              r.elevation_gain_m
         FROM kamchatka_routes r
        WHERE r.is_visible = true AND r.merged_into_id IS NULL
        ORDER BY r.title`,
    );

    const byKind: Record<string, number> = {};
    const offenders: Array<{
      id: string;
      title: string;
      kinds: ContradictionKind[];
      what: string[];
      evidence: string[];
    }> = [];
    let uncheckedTotal = 0;

    for (const r of rows) {
      const { contradictions, unchecked } = judgeRoute({
        title: r.title,
        activityType: r.activity_type,
        season: r.season,
        distanceKm: r.distance_km === null ? null : Number(r.distance_km),
        durationHours: r.duration_hours === null ? null : Number(r.duration_hours),
        elevationGainM: r.elevation_gain_m,
        description: r.description,
      });
      if (unchecked.length > 0) uncheckedTotal += 1;
      if (contradictions.length === 0) continue;
      for (const c of contradictions) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      offenders.push({
        id: r.id,
        title: r.title,
        kinds: contradictions.map((c) => c.kind),
        what: contradictions.map((c) => c.what),
        evidence: contradictions.map((c) => c.evidence),
      });
    }

    return NextResponse.json({
      ok: true,
      routes_total: rows.length,
      offenders_total: offenders.length,
      by_kind: byKind,
      /** Записей, где хоть что-то судить не вышло. НЕ «в порядке». */
      unchecked_total: uncheckedTotal,
      offenders,
      note: 'Перепись только читает. Какое из двух чисел неверно — решает человек.',
    });
  } catch (err) {
    // Отказ переписи — «не смог», а не «нарушений нет» (§4.0).
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code) : 'нет кода';
    console.error('[route-sanity-census] перепись не выполнена', {
      code,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: 'Перепись не выполнена — это не «нарушений нет»', code },
      { status: 500 },
    );
  }
}
