/**
 * lib/ai/query-expansion.ts
 *
 * Multi-query расширение для RAG (Roitman §16.5): для коротких/неоднозначных
 * запросов генерируем 2-3 перефраза/синонима, ищем по всем и объединяем —
 * закрывает vocabulary-gap БЕЗ векторов (у нас лимит standalone 50 МБ).
 *
 * Поведенческое изменение + latency (доп. AI-вызов перед поиском), поэтому
 * ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО (env RAG_MULTIQUERY=1). Выключено → expandQuery
 * мгновенно возвращает [original], нулевое изменение поведения и стоимости.
 * Fail-open: при сбое AI/парсинга → [original].
 */

import { callAIFast } from '@/lib/ai/providers';

const MAX_VARIANTS = 3;        // не считая оригинала
const MAX_WORDS_TO_EXPAND = 6; // длинные запросы уже специфичны — не расширяем

export function multiQueryEnabled(): boolean {
  return process.env.RAG_MULTIQUERY === '1';
}

/**
 * Парсит варианты из ответа модели (строки или JSON-массив), нормализует,
 * дедуплицирует против оригинала, ограничивает MAX_VARIANTS. Чистая функция.
 */
export function parseQueryVariants(raw: string, original: string): string[] {
  const result = [original];
  if (!raw) return result;

  let candidates: string[] = [];
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (Array.isArray(parsed)) candidates = parsed.map(String);
    } catch { /* fall through to line parsing */ }
  }
  if (candidates.length === 0) {
    candidates = raw
      .split('\n')
      .map(l => l.replace(/^[\s\d.)*-]+/, '').trim()) // снять маркеры списка
      .filter(Boolean);
  }

  const origNorm = original.trim().toLowerCase();
  for (const c of candidates) {
    const v = c.replace(/["'`]/g, '').trim().slice(0, 100);
    if (!v) continue;
    const norm = v.toLowerCase();
    if (norm === origNorm) continue;
    if (result.some(r => r.toLowerCase() === norm)) continue;
    result.push(v);
    if (result.length >= MAX_VARIANTS + 1) break;
  }
  return result;
}

const PROMPT = (q: string) =>
  `Пользователь ищет по туристической базе Камчатки. Дай ${MAX_VARIANTS} коротких ` +
  `перефраза/синонима запроса (другими словами, та же суть) — для полнотекстового поиска. ` +
  `Только варианты, по одному на строку, без нумерации и пояснений.\n\nЗапрос: ${q}`;

/**
 * Возвращает [оригинал, ...перефразы]. Без флага — мгновенно [оригинал].
 */
export async function expandQuery(query: string): Promise<string[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  if (!multiQueryEnabled()) return [q];
  if (q.split(/\s+/).length > MAX_WORDS_TO_EXPAND) return [q];

  try {
    const raw = await callAIFast([{ role: 'user' as const, content: PROMPT(q) }]);
    return parseQueryVariants(raw, q);
  } catch {
    return [q];
  }
}
