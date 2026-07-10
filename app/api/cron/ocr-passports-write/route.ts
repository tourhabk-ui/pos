/**
 * POST /api/cron/ocr-passports-write — приём готового markdown паспорта от
 * OpenDataLoader-раннера (бесплатный локальный OCR вместо платного Mistral).
 *
 * Раннер (GitHub Actions, Java+Node) прогоняет OpenDataLoader и постит сюда
 * результат; прод пишет в route_passport_ocr (та же таблица, что у Mistral-
 * прогона). Так Java не попадает в прод-бандл (лимит Docker 50 МБ, §6.1), а
 * запись обходит файрвол БД (раннер не ходит в PG напрямую).
 *
 * Bearer CRON_SECRET. Body: { route_id, markdown, pages?, model? }.
 * enriched_at не трогаем: новая строка получит NULL по умолчанию и попадёт
 * в следующий прогон обогащения полей карточки (enrich-passports).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  route_id: z.string().uuid(),
  markdown: z.string().min(1).max(500_000),
  pages: z.number().int().positive().max(2000).nullish(),
  model: z.string().max(50).default('opendataloader-pdf'),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  try {
    // pdf_url берём из маршрута (COALESCE), чтобы сохранить источник.
    const { rows } = await pool.query<{ pdf_url: string | null }>(
      `SELECT COALESCE(official_passport_url, pdf_url) AS pdf_url FROM kamchatka_routes WHERE id = $1`,
      [data.route_id],
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }

    await pool.query(
      `INSERT INTO route_passport_ocr (route_id, pdf_url, markdown, pages, model, processed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (route_id) DO UPDATE
         SET pdf_url = EXCLUDED.pdf_url, markdown = EXCLUDED.markdown,
             pages = EXCLUDED.pages, model = EXCLUDED.model, processed_at = NOW()`,
      [data.route_id, rows[0].pdf_url ?? '', data.markdown, data.pages ?? null, data.model],
    );

    return NextResponse.json({ success: true, route_id: data.route_id, chars: data.markdown.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи OCR';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
