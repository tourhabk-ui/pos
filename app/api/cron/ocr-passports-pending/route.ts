/**
 * GET /api/cron/ocr-passports-pending — список паспортов маршрутов, ещё не
 * оцифрованных (нет строки в route_passport_ocr), с PDF в base64.
 *
 * Зачем PDF прямо отсюда: OCR через OpenDataLoader гоняется на GitHub-раннере
 * (там есть Java+Node), но visitkamchatka.ru — РФ-сайт, с US-раннера может не
 * открыться. Прод (РФ-IP Timeweb) скачивает PDF сам и отдаёт base64 — раннеру
 * не нужно тянуть RU-ресурс. Раннер прогоняет OpenDataLoader локально
 * (бесплатно, вместо платного Mistral OCR) и постит markdown в
 * /api/cron/ocr-passports-write.
 *
 * Bearer CRON_SECRET. Query: limit (1..5, default 3), offset (мимо тех, чей
 * PDF не скачался).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_PDF_BYTES = 25 * 1024 * 1024;

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function downloadPdfB64(url: string): Promise<{ b64: string; bytes: number } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'KamchatourHub-PassportOCR/1.0 (+https://vedarai.ru)' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return { error: `PDF HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { error: 'PDF пустой' };
    if (buf.length > MAX_PDF_BYTES) return { error: `PDF > ${MAX_PDF_BYTES} байт` };
    return { b64: buf.toString('base64'), bytes: buf.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const limit = intParam(sp.get('limit'), 3, 1, 5);
  const offset = intParam(sp.get('offset'), 0, 0, 10_000);

  try {
    const { rows } = await pool.query<{ route_id: string; title: string; pdf_url: string }>(`
      SELECT r.id AS route_id, r.title, COALESCE(r.official_passport_url, r.pdf_url) AS pdf_url
      FROM kamchatka_routes r
      WHERE COALESCE(r.official_passport_url, r.pdf_url) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM route_passport_ocr o WHERE o.route_id = r.id)
      ORDER BY r.title
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const total = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM kamchatka_routes r
      WHERE COALESCE(r.official_passport_url, r.pdf_url) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM route_passport_ocr o WHERE o.route_id = r.id)
    `);

    const items: Array<{ route_id: string; title: string; pdf_url: string; pdf_b64?: string; error?: string }> = [];
    for (const r of rows) {
      const dl = await downloadPdfB64(r.pdf_url);
      if ('error' in dl) {
        items.push({ route_id: r.route_id, title: r.title, pdf_url: r.pdf_url, error: dl.error });
      } else {
        items.push({ route_id: r.route_id, title: r.title, pdf_url: r.pdf_url, pdf_b64: dl.b64 });
      }
    }

    return NextResponse.json({
      success: true,
      pending_total: parseInt(total.rows[0].count),
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка выборки паспортов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
