/**
 * Клиент Mistral OCR (mistral-ocr-latest) — извлечение markdown из PDF.
 *
 * Используется прогоном паспортов маршрутов (lib/import/passport-ocr-runner.ts).
 * PDF передаётся как data-URI base64 (документированный путь Mistral OCR):
 * скачиваем сами на прод-сервере (visitkamchatka.ru с РФ-IP доступен всегда),
 * а не отдаём Mistral внешнюю ссылку — их EU-фетчер к RU-сайту может не пройти.
 *
 * Ключ — MISTRAL_API_KEY (env Timeweb), как у callMistral в waterfall.
 * Цена: ~$2-4 за 1000 страниц; наш объём ~100 PDF — разовые копейки.
 */

import { getMistralKey } from '@/lib/ai/provider-config';

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
export const MISTRAL_OCR_MODEL = 'mistral-ocr-latest';

export interface OcrPage {
  index: number;
  markdown: string;
}

export interface OcrResult {
  markdown: string;
  pages: number;
}

/** Склейка постраничного markdown в один документ (чистая, покрыта тестами). */
export function joinOcrPages(pages: OcrPage[]): string {
  return pages
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((p) => p.markdown.trim())
    .filter(Boolean)
    .join('\n\n');
}

export async function ocrPdfBase64(base64: string): Promise<OcrResult> {
  const key = getMistralKey();
  if (!key) throw new Error('MISTRAL_API_KEY не задан в окружении');

  const res = await fetch(MISTRAL_OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MISTRAL_OCR_MODEL,
      document: {
        type: 'document_url',
        document_url: `data:application/pdf;base64,${base64}`,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mistral OCR HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as { pages?: OcrPage[] };
  const pages = (data.pages ?? []).filter((p) => typeof p.markdown === 'string');
  if (pages.length === 0) throw new Error('Mistral OCR: в ответе нет страниц');

  return { markdown: joinOcrPages(pages), pages: pages.length };
}
