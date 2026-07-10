/**
 * GET /api/cron/ocr-passports — партия OCR-прогона PDF-паспортов маршрутов
 * через Mistral OCR, исполняемая НА прод-сервере.
 *
 * Зачем с прода: файрвол managed PostgreSQL Timeweb не пускает внешние IP
 * (паттерн /api/cron/osm-import), плюс visitkamchatka.ru гарантированно
 * доступен с РФ-IP. Дёргается workflow'ом ocr-passports-prod.yml с Bearer
 * CRON_SECRET в цикле по партиям.
 *
 * Query: limit (1..5, default 3 — OCR одного PDF занимает 5-20с, партия
 * держится в пределах таймаута прокси), dry_run=true|false (dry: скачать
 * PDF без похода в Mistral и без записи), offset (сдвиг мимо упавших).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runPassportOcr } from '@/lib/import/passport-ocr-runner';

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
  const offset = intParam(sp.get('offset'), 0, 0, 10_000);
  const dryRun = sp.get('dry_run') === 'true';

  try {
    const result = await runPassportOcr({ limit, dryRun, offset });
    return NextResponse.json({
      success: true,
      dry_run: result.dry_run,
      offset,
      processed: result.processed,
      succeeded: result.succeeded,
      errors: result.errors.length,
      error_details: result.errors.slice(0, 10),
      routes_without_ocr: result.routes_without_ocr,
      details: result.details,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка OCR-прогона паспортов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
