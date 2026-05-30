/**
 * lib/agents/editor.ts
 *
 * Editor — AI-редактор описаний маршрутов.
 * Запускается раз в сутки через /api/cron/editor.
 *
 * Источник: agent_route_knowledge (1386 маршрутов Камчатки).
 * Критерий: description IS NULL или LENGTH(description) < 300.
 * Действие: генерирует описание через AI → UPDATE agent_route_knowledge.
 * Лимит: 15 маршрутов за запуск.
 */

import { pool } from '@/lib/db-pool';
import { callAIWaterfall } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface EditorResult {
  processed: number;
  improved: number;
  improved_titles: string[];
  errors: number;
  duration_ms: number;
}

const BATCH_SIZE = 15;
const MIN_DESCRIPTION_LENGTH = 300;

// Minimum generated length to accept (shorter = likely truncated or refused)
const MIN_GENERATED_CHARS = 200;

// Generic AI refusal / hallucination signals — reject if found
const REJECTION_PATTERNS = [
  /я не могу/i, /не имею информации/i, /мне не известно/i,
  /извините, я/i, /как языковая модель/i, /как ИИ/i,
  /не могу создать/i, /не могу написать/i,
];

// At least one Kamchatka-specific term must appear (basic relevance check)
const RELEVANCE_TERMS = [
  /камчатк/i, /полуостров/i, /тихоокеан/i, /вулкан/i, /гейзер/i,
  /термальн/i, /медведь/i, /медведей/i, /лосось/i, /тундр/i,
  /кратер/i, /сопк/i, /лав/i, /тектоник/i, /магм/i, /нерест/i,
];

function validateGeneratedDescription(title: string, description: string): { valid: boolean; reason?: string } {
  if (description.length < MIN_GENERATED_CHARS) {
    return { valid: false, reason: `слишком короткое (${description.length} < ${MIN_GENERATED_CHARS})` };
  }
  for (const pat of REJECTION_PATTERNS) {
    if (pat.test(description)) {
      return { valid: false, reason: 'содержит отказ/признак галлюцинации' };
    }
  }
  // Title word must appear OR at least one Kamchatka term
  const titleWord = title.split(/\s+/)[0] ?? '';
  const hasTitle = titleWord.length > 3 && description.toLowerCase().includes(titleWord.toLowerCase());
  const hasGeo = RELEVANCE_TERMS.some(p => p.test(description));
  if (!hasTitle && !hasGeo) {
    return { valid: false, reason: 'нет признаков релевантности Камчатке' };
  }
  return { valid: true };
}

async function tgSend(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* silent */ }
}

interface RouteRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
}

async function findRoutesNeedingDescription(): Promise<RouteRow[]> {
  const { rows } = await pool.query<RouteRow>(`
    SELECT id, title, description, category
    FROM agent_route_knowledge
    WHERE description IS NULL
       OR LENGTH(description) < $1
    ORDER BY RANDOM()
    LIMIT $2
  `, [MIN_DESCRIPTION_LENGTH, BATCH_SIZE]);
  return rows;
}

const CATEGORY_LABELS: Record<string, string> = {
  vulkani:              'вулкан',
  termalnye_istochniki: 'термальные источники',
  geyzery:              'гейзеры',
  eco:                  'экотуризм',
  trekking:             'треккинг',
  lakes:                'озёра',
  rivers:               'реки',
  mountains:            'горы',
  rybalka:              'рыбалка',
  morskie_progulki:     'морские прогулки',
  vertoletnye_tury:     'вертолётные туры',
  medvedi:              'наблюдение за медведями',
  ekskursii:            'экскурсии',
  dzhip:                'джип-туры',
  ozera:                'озёра',
};

async function generateRouteDescription(route: RouteRow): Promise<string | null> {
  const categoryLabel = route.category ? (CATEGORY_LABELS[route.category] ?? route.category) : '';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты эксперт по туризму на Камчатке. Пишешь краткие, точные описания природных объектов и маршрутов для туристической платформы Ведар.
Стиль: фактически точный, живой, без рекламных штампов. Без emoji. Без markdown.
Длина: 2-3 абзаца, 200-350 слов. Упоминай конкретные детали (координаты, высоту, особенности) если знаешь.`,
    },
    {
      role: 'user',
      content: `Напиши описание для туристического объекта:
Название: ${route.title}
${categoryLabel ? `Тип: ${categoryLabel}` : ''}
${route.description ? `Имеющееся описание (расширь и улучши): ${route.description}` : 'Описания нет — создай с нуля на основе названия.'}

Описание должно помочь туристу понять: что это за место, чем оно уникально, когда лучше посещать, что стоит знать перед поездкой.`,
    },
  ];

  try {
    const result = await callAIWaterfall(messages);
    return result?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function runEditor(): Promise<EditorResult> {
  const start = Date.now();
  let processed = 0;
  let improved  = 0;
  let errors    = 0;

  const improvedTitles: string[] = [];

  let routes: RouteRow[];
  try {
    routes = await findRoutesNeedingDescription();
  } catch {
    return { processed: 0, improved: 0, improved_titles: [], errors: 1, duration_ms: Date.now() - start };
  }

  for (const route of routes) {
    processed++;
    const newDescription = await generateRouteDescription(route);
    if (!newDescription) {
      errors++;
      continue;
    }
    const validation = validateGeneratedDescription(route.title, newDescription);
    if (!validation.valid) {
      errors++;
      continue;
    }
    try {
      await pool.query(
        `UPDATE agent_route_knowledge
         SET description = $1,
             search_text = COALESCE(search_text, '') || ' ' || $1
         WHERE id = $2`,
        [newDescription, route.id],
      );
      improved++;
      improvedTitles.push(route.title);
    } catch {
      errors++;
    }
  }

  if (improved > 0) {
    let remaining = 0;
    try {
      const { rows } = await pool.query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM agent_route_knowledge WHERE description IS NULL OR LENGTH(description) < $1',
        [MIN_DESCRIPTION_LENGTH]
      );
      remaining = Number(rows[0]?.cnt ?? 0);
    } catch { /* fallback */ remaining = -1; }

    const titlesList = improvedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    await tgSend(
      `<b>Editor</b> — улучшил ${improved} описаний\n` +
      `(обработано: ${processed}, ошибок: ${errors}, осталось кратких: ${remaining >= 0 ? remaining : '?'})\n\n` +
      `<b>Улучшенные маршруты и локации:</b>\n${titlesList}`,
    );
  }

  return { processed, improved, improved_titles: improvedTitles, errors, duration_ms: Date.now() - start };
}
