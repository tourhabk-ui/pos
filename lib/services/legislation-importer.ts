/**
 * lib/services/legislation-importer.ts
 *
 * Парсинг законодательства/нормативки для туристов с официальных сайтов
 * (по умолчанию — Путешествуем.рф, национальный турпортал).
 *
 * Архитектура (layout-agnostic, без CSS-селекторов и догадок о вёрстке):
 *   1. URL'ы приходят ПАРАМЕТРОМ (или env LEGISLATION_SOURCE_URLS) — не хардкод
 *   2. Firecrawl скрейпит страницу → markdown (работает с любой вёрсткой)
 *   3. AI (waterfall) добавляет ТОЛЬКО summary + category (ярлык)
 *   4. full_text = дословный markdown оригинала — источник истины, AI его не переписывает
 *   5. UPSERT в legislation_docs по source_url
 *
 * Анти-галлюцинация: AI не сочиняет нормы. Текст закона = оригинал.
 * effective_date = null, если на странице не указана (не выдумывать).
 *
 * Тихо выходит если Firecrawl не настроен (нет FIRECRAWL_API_KEY) или нет URL'ов.
 * Реальный скрейп идёт с прод-окружения (Timeweb, RU) — оно достаёт .рф домены.
 */

import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { firecrawlScrape, firecrawlAvailable } from '@/lib/services/firecrawl';
import { callAIWaterfall } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

// ── Категории нормативки ─────────────────────────────────────────────────────

const CATEGORIES = [
  'registration',     // регистрация туристов / МЧС
  'national_parks',   // нацпарки, ООПТ, пропуска
  'tour_operators',   // операторы, реестр, фингарантии
  'insurance',        // страхование туристов
  'safety',           // безопасность, требования к маршрутам
  'tourist_rights',   // права туриста, возвраты
  'visa_border',      // визы, погранзоны
  'other',
] as const;

const LegislationSchema = z.object({
  title: z.string().min(3),
  category: z.enum(CATEGORIES),
  summary: z.string().min(10),                 // простыми словами, без юр-воды
  effective_date: z.string().nullable(),       // null если не указана — НЕ выдумывать
});

type LegislationStructured = z.infer<typeof LegislationSchema>;

export interface LegislationImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  reason?: string;
}

// ── Источник URL'ов ──────────────────────────────────────────────────────────

/**
 * URL'ы законодательства. Приоритет: явный параметр → env LEGISLATION_SOURCE_URLS.
 * Никаких захардкоженных «угаданных» путей: владелец задаёт точные страницы.
 */
function resolveUrls(urls?: string[]): string[] {
  if (urls && urls.length > 0) return urls.map(u => u.trim()).filter(Boolean);
  const fromEnv = process.env.LEGISLATION_SOURCE_URLS;
  if (!fromEnv) return [];
  return fromEnv.split(',').map(u => u.trim()).filter(Boolean);
}

// ── AI-структуризация одной страницы ─────────────────────────────────────────

const EXTRACT_PROMPT = `Ты — юридический аналитик туристической платформы. Тебе дают ТЕКСТ официальной страницы о законодательстве/правилах для туристов.

Задача: вернуть ОДИН JSON-объект с метаданными страницы. Текст закона НЕ переписывай — его сохраняем отдельно дословно.

Формат строго:
{
  "title": "короткий заголовок документа/темы",
  "category": "одно из: registration | national_parks | tour_operators | insurance | safety | tourist_rights | visa_border | other",
  "summary": "2-4 предложения простыми словами: что регулирует и что важно туристу",
  "effective_date": "дата вступления в силу если ЯВНО указана в тексте, иначе null"
}

ПРАВИЛА:
- Если поле не выводится из текста — null (для effective_date) или "other" (для category). НЕ ВЫДУМЫВАЙ.
- summary только из того, что реально написано на странице. Никаких домыслов о нормах.
- Верни ТОЛЬКО JSON, без markdown-обёрток.`;

async function structurePage(markdown: string): Promise<LegislationStructured | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_PROMPT },
    { role: 'user', content: markdown.slice(0, 12_000) },
  ];

  let raw: string;
  try {
    raw = await callAIWaterfall(messages);
  } catch {
    return null;
  }
  if (!raw) return null;

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;

  try {
    const parsed = LegislationSchema.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── Главная: импорт законодательства ─────────────────────────────────────────

export async function importLegislation(urls?: string[]): Promise<LegislationImportResult> {
  const result: LegislationImportResult = { imported: 0, skipped: 0, errors: [] };

  if (!firecrawlAvailable()) {
    result.reason = 'firecrawl_not_configured';
    return result;
  }

  const targets = resolveUrls(urls);
  if (targets.length === 0) {
    result.reason = 'no_urls';
    return result;
  }

  for (const url of targets.slice(0, 30)) {
    try {
      const page = await firecrawlScrape(url);
      if (!page || !page.markdown || page.markdown.trim().length < 50) {
        result.skipped++;
        continue;
      }

      const structured = await structurePage(page.markdown);
      if (!structured) {
        result.skipped++;
        result.errors.push(`structure failed: ${url}`);
        continue;
      }

      // full_text = дословный оригинал (источник истины), не AI-пересказ
      const fullText = page.markdown.slice(0, 20_000);
      const title = (page.metadata?.title || structured.title).slice(0, 500);

      await pool.query(
        `INSERT INTO legislation_docs
           (source_url, source, title, category, summary, full_text, effective_date, parsed_at, is_stale, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), FALSE, NOW())
         ON CONFLICT (source_url) DO UPDATE SET
           title          = EXCLUDED.title,
           category       = EXCLUDED.category,
           summary        = EXCLUDED.summary,
           full_text      = EXCLUDED.full_text,
           effective_date = EXCLUDED.effective_date,
           parsed_at      = NOW(),
           is_stale       = FALSE,
           updated_at     = NOW()`,
        [
          url,
          'Путешествуем.рф',
          title,
          structured.category,
          structured.summary.slice(0, 2000),
          fullText,
          structured.effective_date,
        ],
      );
      result.imported++;
    } catch (e) {
      result.errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

// ── Поиск нормативки для контекста Кузьмича ──────────────────────────────────

interface LegislationRow {
  title: string;
  summary: string | null;
  effective_date: string | null;
  source_url: string;
}

/**
 * Ищет релевантные документы законодательства под запрос пользователя.
 * Возвращает текст для системного промпта Кузьмича — со ссылкой на источник,
 * чтобы агент цитировал норму, а не выдумывал.
 */
export async function searchLegislation(query: string): Promise<string> {
  if (!query || query.length < 3) return '';
  const q = query
    .replace(/[^\wа-яёА-ЯЁ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!q) return '';

  try {
    // Сначала FTS (русский), при пустом результате — ILIKE по заголовку/summary
    const { rows } = await pool.query<LegislationRow>(
      `SELECT title, summary, effective_date, source_url
       FROM legislation_docs
       WHERE to_tsvector('russian',
               coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(full_text,''))
             @@ plainto_tsquery('russian', $1)
       ORDER BY parsed_at DESC
       LIMIT 3`,
      [q],
    );

    let found = rows;
    if (found.length === 0) {
      const fallback = await pool.query<LegislationRow>(
        `SELECT title, summary, effective_date, source_url
         FROM legislation_docs
         WHERE title ILIKE $1 OR summary ILIKE $1
         ORDER BY parsed_at DESC
         LIMIT 3`,
        [`%${q}%`],
      );
      found = fallback.rows;
    }

    if (found.length === 0) return '';

    const lines = found.map(r => {
      const date = r.effective_date ? ` (действует с ${r.effective_date})` : '';
      return `Документ: ${r.title}${date}\n${(r.summary ?? '').slice(0, 500)}\nИсточник: ${r.source_url}`;
    });
    return `=== Законодательство по запросу (официальные источники) ===\n${lines.join('\n\n')}`.slice(0, 2200);
  } catch {
    return '';
  }
}
