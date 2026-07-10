/**
 * GET /api/cron/enrich-passports — партия обогащения карточек маршрутов из
 * OCR-паспортов (route_passport_ocr → kamchatka_routes), на прод-сервере.
 *
 * Зачем с прода: файрвол managed PostgreSQL Timeweb (паттерн osm-import /
 * ocr-passports). Дёргается workflow'ом enrich-passports-prod.yml с Bearer
 * CRON_SECRET в цикле по партиям (селект по enriched_at IS NULL — offset не
 * нужен, обработанные строки выпадают из выборки).
 *
 * Query: limit (1..5, default 3 — LLM-разбор одного паспорта 3-15с),
 * dry_run=true|false (dry: разобрать и показать, что записалось бы, без UPDATE
 * и без пометки enriched_at).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runPassportEnrich } from '@/lib/import/passport-enrich-runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const limit = intParam(sp.get('limit'), 3, 1, 5);
  const dryRun = sp.get('dry_run') === 'true';

  try {
    const result = await runPassportEnrich({ limit, dryRun });
    return NextResponse.json({
      success: true,
      dry_run: result.dry_run,
      processed: result.processed,
      enriched: result.enriched,
      fields_written: result.fields_written,
      errors: result.errors.length,
      error_details: result.errors.slice(0, 10),
      routes_pending: result.routes_pending,
      details: result.details,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка обогащения паспортов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
