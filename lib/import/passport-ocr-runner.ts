/**
 * Раннер OCR-прогона PDF-паспортов маршрутов (Mistral OCR) — партиями,
 * исполняется НА прод-сервере (паттерн lib/import/osm-import-runner.ts:
 * файрвол managed PostgreSQL Timeweb не пускает внешние IP, а с прода
 * и БД, и visitkamchatka.ru (RU-IP), и api.mistral.ai доступны).
 *
 * Выборка: маршруты с паспортом (official_passport_url приоритетнее
 * legacy pdf_url) и без строки в route_passport_ocr (migration 730).
 * offset — сдвиг мимо маршрутов с ошибками (упавшие остаются в выборке
 * и без сдвига зациклили бы batched-перебор).
 *
 * dry-run: скачивает PDF (проверка доступности/размера), Mistral НЕ
 * дёргает (платный) и в БД не пишет.
 */

import { pool } from '@/lib/db-pool';
import { ocrPdfBase64, MISTRAL_OCR_MODEL } from '@/lib/services/ingest/mistral-ocr';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_DELAY_MS = 1500; // free tier Mistral ~1 RPS — держим паузу между документами

export interface PassportOcrParams {
  limit: number;
  dryRun: boolean;
  offset?: number;
  /** Пауза между документами, мс (в тестах — 0). */
  delayMs?: number;
}

export interface PassportOcrDetail {
  id: string;
  title: string;
  status: 'ocr_done' | 'dry_run' | 'error';
  pages?: number;
  chars?: number;
  pdf_kb?: number;
}

export interface PassportOcrResult {
  dry_run: boolean;
  processed: number;
  succeeded: number;
  errors: string[];
  routes_without_ocr: number;
  details: PassportOcrDetail[];
}

async function downloadPdf(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'KamchatourHub-PassportOCR/1.0 (+https://vedarai.ru)' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('PDF пустой (0 байт)');
  if (buf.length > MAX_PDF_BYTES) throw new Error(`PDF слишком большой (${Math.round(buf.length / 1024 / 1024)} МБ)`);
  return buf;
}

export async function runPassportOcr(params: PassportOcrParams): Promise<PassportOcrResult> {
  const { limit, dryRun } = params;
  const offset = params.offset ?? 0;
  const delayMs = params.delayMs ?? DEFAULT_DELAY_MS;

  const { rows: routes } = await pool.query<{ id: string; title: string; pdf_url: string }>(`
    SELECT r.id, r.title, COALESCE(r.official_passport_url, r.pdf_url) AS pdf_url
    FROM kamchatka_routes r
    WHERE COALESCE(r.official_passport_url, r.pdf_url) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM route_passport_ocr o WHERE o.route_id = r.id)
    ORDER BY r.title
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const total = await pool.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM kamchatka_routes r
    WHERE COALESCE(r.official_passport_url, r.pdf_url) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM route_passport_ocr o WHERE o.route_id = r.id)
  `);

  let succeeded = 0;
  const errors: string[] = [];
  const details: PassportOcrDetail[] = [];

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    try {
      const pdf = await downloadPdf(r.pdf_url);

      if (dryRun) {
        succeeded++;
        details.push({ id: r.id, title: r.title, status: 'dry_run', pdf_kb: Math.round(pdf.length / 1024) });
      } else {
        const ocr = await ocrPdfBase64(pdf.toString('base64'));
        await pool.query(
          `INSERT INTO route_passport_ocr (route_id, pdf_url, markdown, pages, model, processed_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (route_id) DO UPDATE
             SET pdf_url = EXCLUDED.pdf_url, markdown = EXCLUDED.markdown,
                 pages = EXCLUDED.pages, model = EXCLUDED.model, processed_at = NOW()`,
          [r.id, r.pdf_url, ocr.markdown, ocr.pages, MISTRAL_OCR_MODEL],
        );
        succeeded++;
        details.push({ id: r.id, title: r.title, status: 'ocr_done', pages: ocr.pages, chars: ocr.markdown.length });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${r.title}: ${msg}`);
      details.push({ id: r.id, title: r.title, status: 'error' });
    }

    if (delayMs > 0 && i < routes.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return {
    dry_run: dryRun,
    processed: routes.length,
    succeeded,
    errors,
    routes_without_ocr: parseInt(total.rows[0].count),
    details,
  };
}
