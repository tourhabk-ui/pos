/**
 * GET  /api/cron/legislation-sync?secret=<CRON_SECRET>
 * POST /api/cron/legislation-sync   { "secret": "...", "urls": ["https://..."] }
 *
 * Парсинг законодательства/правил для туристов с официальных источников
 * (по умолчанию — Путешествуем.рф). URL'ы берутся из тела POST или env
 * LEGISLATION_SOURCE_URLS (через запятую). Firecrawl → AI summary → legislation_docs.
 *
 * Требует FIRECRAWL_API_KEY и хотя бы один URL. Без них вернёт reason без записи.
 * Реальный скрейп .рф идёт с прод-окружения (Timeweb, RU).
 * Рекомендуемый интервал: раз в сутки/неделю.
 */

import { NextRequest, NextResponse } from 'next/server';
import { importLegislation } from '@/lib/services/legislation-importer';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorize(secret: string | null): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authErr = authorize(getCronSecret(request));
  if (authErr) return authErr;

  try {
    const result = await importLegislation();
    return NextResponse.json({ ok: result.errors.length === 0, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let body: { secret?: string; urls?: string[] } = {};
  try {
    body = (await request.json()) as { secret?: string; urls?: string[] };
  } catch {
    /* пустое тело — попробуем secret из query/header */
  }

  const secret = body.secret ?? getCronSecret(request);
  const authErr = authorize(secret);
  if (authErr) return authErr;

  const urls = Array.isArray(body.urls) ? body.urls.filter(u => typeof u === 'string') : undefined;

  try {
    const result = await importLegislation(urls);
    return NextResponse.json({ ok: result.errors.length === 0, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
