/**
 * GET /api/admin/model-catalog — цены моделей и во что обходится НАША работа.
 *
 * Показывает не прайс, а счёт за прогоны: прайс сам по себе не сравним между
 * моделями, потому что у нас есть и входо-тяжёлая работа (судья читает много,
 * отвечает строкой), и выходо-тяжёлая (Editor читает мало, пишет абзац).
 * Формы и расчёт — `lib/ai/model-cost.ts`, одно место на все поверхности.
 *
 * Свежесть названа вслух. Каталог привозит раннер (`model-catalog.yml`), прод
 * сам его спросить не может — 403. Значит «цены на экране» могут быть
 * вчерашними, и различать «цена такая» от «мы давно не спрашивали» обязана
 * страница, а не догадка смотрящего.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { WORKLOADS, workloadCostUsd, workloadMonthlyUsd } from '@/lib/ai/model-cost';

export const dynamic = 'force-dynamic';

/** Каталог считается несвежим через сутки: раннер ходит раз в день. */
const STALE_AFTER_HOURS = 26;

const QuerySchema = z.object({
  q: z.string().max(100).optional(),
  vendor: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

interface Row {
  model_id: string;
  vendor: string;
  display_name: string | null;
  usd_per_mtok_in: string | null;
  usd_per_mtok_out: string | null;
  context_length: number | null;
  last_seen_at: Date;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const parsed = QuerySchema.safeParse({
    q: req.nextUrl.searchParams.get('q') ?? undefined,
    vendor: req.nextUrl.searchParams.get('vendor') ?? undefined,
    limit: req.nextUrl.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректные параметры' }, { status: 400 });
  }
  const { q, vendor, limit } = parsed.data;

  const { rows: freshRows } = await pool.query<{ latest: Date | null; total: string }>(
    `SELECT MAX(last_seen_at) AS latest, COUNT(*)::text AS total FROM model_catalog`,
  );
  const latest: Date | null = freshRows[0]?.latest ?? null;
  const total = Number(freshRows[0]?.total ?? 0);

  // Каталог не приезжал НИ РАЗУ — это не «моделей нет». Пустой экран без
  // объяснения читается как «выбирать не из чего», а правда другая: мы не
  // спрашивали (§4.0).
  if (!latest || total === 0) {
    return NextResponse.json({
      success: true,
      freshness: { state: 'never', latest_at: null, hours_ago: null, models_total: 0 },
      workloads: WORKLOADS,
      estimated: true,
      models: [],
      note: 'Каталог ни разу не приезжал. Прод не может спросить OpenRouter сам (403) — цены привозит прогон model-catalog.yml.',
    });
  }

  const hoursAgo = (Date.now() - new Date(latest).getTime()) / 3_600_000;
  const state = hoursAgo > STALE_AFTER_HOURS ? 'stale' : 'fresh';

  const where: string[] = [];
  const params: unknown[] = [];
  if (q) { params.push(`%${q}%`); where.push(`(model_id ILIKE $${params.length} OR display_name ILIKE $${params.length})`); }
  if (vendor) { params.push(vendor); where.push(`vendor = $${params.length}`); }
  params.push(limit);

  const { rows } = await pool.query<Row>(
    `SELECT model_id, vendor, display_name, usd_per_mtok_in, usd_per_mtok_out,
            context_length, last_seen_at
       FROM model_catalog
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY usd_per_mtok_in ASC NULLS LAST, model_id ASC
      LIMIT $${params.length}`,
    params,
  );

  const latestMs = new Date(latest).getTime();

  const models = rows.map((r) => {
    const price = { usdPerMTokIn: num(r.usd_per_mtok_in), usdPerMTokOut: num(r.usd_per_mtok_out) };
    return {
      model_id: r.model_id,
      vendor: r.vendor,
      display_name: r.display_name,
      usd_per_mtok_in: price.usdPerMTokIn,
      usd_per_mtok_out: price.usdPerMTokOut,
      context_length: r.context_length,
      // Модель могла выбыть из каталога: строка осталась, но её цена — не
      // сегодняшняя. Показывать её наравне с живыми значило бы выдать
      // вчерашнее за текущее.
      in_latest_batch: new Date(r.last_seen_at).getTime() >= latestMs,
      last_seen_at: r.last_seen_at,
      cost: Object.fromEntries(
        WORKLOADS.map((w) => [
          w.key,
          { per_run_usd: workloadCostUsd(price, w), per_month_usd: workloadMonthlyUsd(price, w) },
        ]),
      ),
    };
  });

  return NextResponse.json({
    success: true,
    freshness: {
      state,
      latest_at: latest,
      hours_ago: Math.round(hoursAgo * 10) / 10,
      models_total: total,
      stale_after_hours: STALE_AFTER_HOURS,
    },
    // Формы работы — ОЦЕНКА из потолков в коде, не замер. Флаг едет наружу,
    // чтобы страница сказала это словами: по этим числам решают, менять ли
    // модель.
    estimated: true,
    workloads: WORKLOADS,
    models,
  });
}
