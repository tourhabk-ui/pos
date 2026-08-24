/**
 * GET /api/cron/route-core-ocr-peek?secret=<CRON_SECRET>&ids=id1,id2,...
 *
 * ДИАГНОСТИКА. Проба 197 (route-core-sources) показала: у всех 20 записей
 * ядра Ф5 есть источник, у 18 — официальный PDF-паспорт visitkamchatka.ru,
 * и по хешу/полям видно, что enrich-passports уже прошёл по ним (hazards,
 * mchs_required, park_name заполнены). Тот пайплайн вытаскивает из паспорта
 * ТОЛЬКО метаданные (lib/import/passport-fields.ts — distance/difficulty/
 * hazards/equipment/park_name); ни трек, ни путевые точки он не извлекает.
 *
 * Прежде чем строить парсер координат — читаем, есть ли в самом
 * OCR-markdown хоть что-то похожее на путь: координаты, названные точки
 * маршрута, раздел «как добраться». Если этого в паспорте нет вовсе —
 * извлекать нечего, и дыра действительно закрывается только полем-полем
 * (GPX от оператора/МЧС), а не парсером текста.
 *
 * READ-ONLY, id передаются явно.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PREVIEW_CHARS = 3000;

interface Row {
  route_id: string;
  pdf_url: string;
  markdown: string;
  pages: number | null;
  processed_at: string;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('ids') ?? '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Передайте ?ids=id1,id2,...' }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT route_id::text, pdf_url, markdown, pages, processed_at::text
         FROM route_passport_ocr
        WHERE route_id::text = ANY($1::text[])`,
      [ids],
    );

    // Ищем то, что похоже на координаты: пары чисел вида "52.912" рядом,
    // или явные слова «координаты»/N/E/с.ш./в.д. Это НЕ парсер, только
    // индикатор — стоит ли вообще строить парсер.
    const coordLike = /\b\d{2}\.\d{3,6}[°]?\s*[,;\s]\s*\d{2,3}\.\d{3,6}[°]?\b|координат|с\.ш\.|в\.д\./i;

    const items = rows.map((r) => ({
      route_id: r.route_id,
      pdf_url: r.pdf_url,
      pages: r.pages,
      processed_at: r.processed_at,
      chars: r.markdown.length,
      looks_like_has_coordinates: coordLike.test(r.markdown),
      preview: r.markdown.slice(0, PREVIEW_CHARS),
    }));

    return NextResponse.json({
      success: true,
      probe: 'route_core_ocr_peek_v1',
      requested: ids.length,
      // OCR не прошёл вовсе — третье состояние, а не «в паспорте пусто».
      ocr_missing: ids.filter((id) => !rows.some((r) => r.route_id === id)),
      items,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Диагностика не выполнена' },
      { status: 500 },
    );
  }
}
