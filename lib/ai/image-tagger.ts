/**
 * AI-автотеггинг фотографий туров через Claude Vision (Anthropic).
 *
 * Почему прямой вызов, а не waterfall: нужно ЗРЕНИЕ, а waterfall текстовый —
 * `pickBestModel` намеренно отсекает vl-модели. Поэтому файл внесён в
 * LLM_EGRESS_FILES, чтобы его хост проверял гвард 152-ФЗ.
 *
 * База берётся из ANTHROPIC_BASE (lib/ai/providers): раньше здесь был
 * захардкожен https://api.anthropic.com, минуя ANTHROPIC_BASE_URL. Хост
 * гео-блокирует РФ-IP, где стоит наш Timeweb, — то есть теггинг не мог
 * отработать в проде вообще, и релей бы его не спас.
 *
 * Ошибки называются, а не глотаются. Прежняя версия на любой сбой (нет ключа,
 * 403 от гео-блока, таймаут) возвращала null, роут отдавал пустые теги и
 * рапортовал «проанализировано 3 фото». Оператор видел успех и ноль тегов, без
 * единого намёка на причину.
 */

import { ANTHROPIC_BASE, fetchWithRetry } from '@/lib/ai/providers';

/** Vision-модель. Переопределяется env без правки кода. */
const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL || 'claude-sonnet-5';

export interface TourImageTags {
  landscape: string[];
  activity: string[];
  difficulty: 'easy' | 'moderate' | 'extreme';
  season: string[];
  features: string[];
}

// Допустимые значения тегов
const ALLOWED_LANDSCAPE = ['volcano', 'geyser', 'ocean', 'forest', 'snow', 'mountain', 'river', 'lake', 'beach', 'tundra'];
const ALLOWED_ACTIVITY = ['hiking', 'fishing', 'boat', 'helicopter', 'skiing', 'camping', 'kayaking', 'snowmobile', 'trekking'];
const ALLOWED_DIFFICULTY = ['easy', 'moderate', 'extreme'];
const ALLOWED_SEASON = ['summer', 'winter', 'spring', 'autumn'];
const ALLOWED_FEATURES = ['wildlife', 'bears', 'salmon', 'birds', 'volcanology', 'aurora', 'hot_springs'];

function sanitizeTags(tags: TourImageTags): TourImageTags {
  return {
    landscape: tags.landscape.filter((t) => ALLOWED_LANDSCAPE.includes(t)).slice(0, 5),
    activity: tags.activity.filter((t) => ALLOWED_ACTIVITY.includes(t)).slice(0, 4),
    difficulty: ALLOWED_DIFFICULTY.includes(tags.difficulty) ? tags.difficulty : 'moderate',
    season: tags.season.filter((t) => ALLOWED_SEASON.includes(t)).slice(0, 4),
    features: tags.features.filter((t) => ALLOWED_FEATURES.includes(t)).slice(0, 5),
  };
}

function parseTagsFromText(text: string): TourImageTags {
  // Пробуем распарсить JSON из ответа
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        landscape: Array.isArray(parsed.landscape) ? parsed.landscape : [],
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
        difficulty: parsed.difficulty ?? 'moderate',
        season: Array.isArray(parsed.season) ? parsed.season : [],
        features: Array.isArray(parsed.features) ? parsed.features : [],
      };
    } catch {
      // Fallback: парсим по ключевым словам
    }
  }

  // Fallback: ищем ключевые слова прямо в тексте
  const lower = text.toLowerCase();
  return {
    landscape: ALLOWED_LANDSCAPE.filter((t) => lower.includes(t)),
    activity: ALLOWED_ACTIVITY.filter((t) => lower.includes(t)),
    difficulty: lower.includes('extreme') ? 'extreme' : lower.includes('easy') ? 'easy' : 'moderate',
    season: ALLOWED_SEASON.filter((t) => lower.includes(t)),
    features: ALLOWED_FEATURES.filter((t) => lower.includes(t)),
  };
}

/** Результат по одному снимку: либо теги, либо названная причина отказа. */
type SingleResult =
  | { ok: true; tags: TourImageTags }
  | { ok: false; reason: string };

// ── Anthropic Claude Vision анализ ───────────────────────────
async function analyzeWithClaude(imageUrl: string): Promise<SingleResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'Не задан ANTHROPIC_API_KEY — автотеггинг отключён' };
  }

  const prompt = `Analyze this Kamchatka tourism photo and return JSON tags ONLY.

Return STRICTLY this JSON format:
{
  "landscape": ["volcano"|"geyser"|"ocean"|"forest"|"snow"|"mountain"|"river"|"lake"|"beach"|"tundra"],
  "activity": ["hiking"|"fishing"|"boat"|"helicopter"|"skiing"|"camping"|"kayaking"|"snowmobile"|"trekking"],
  "difficulty": "easy"|"moderate"|"extreme",
  "season": ["summer"|"winter"|"spring"|"autumn"],
  "features": ["wildlife"|"bears"|"salmon"|"birds"|"volcanology"|"aurora"|"hot_springs"]
}

Rules:
- Only include tags clearly visible or strongly implied in the image
- difficulty: easy=flat trail/family, moderate=hills/some gear, extreme=glacier/summit
- Return ONLY the JSON object, no other text`;

  try {
    const res = await fetchWithRetry(
      `${ANTHROPIC_BASE}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'url', url: imageUrl } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
      },
      { timeoutMs: 20_000, label: 'anthropic:vision' },
    );

    if (!res.ok) {
      // 403 с РФ-IP — почти наверняка гео-блок. Называем прямо: без этого
      // владелец ищет ошибку в ключе или в фото, а причина инфраструктурная.
      const hint =
        res.status === 403
          ? ' (вероятно гео-блок РФ-IP: задайте ANTHROPIC_BASE_URL на релей вне РФ)'
          : '';
      return { ok: false, reason: `Anthropic ответил ${res.status}${hint}` };
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text ?? '';
    if (!text) return { ok: false, reason: 'Пустой ответ модели' };
    return { ok: true, tags: sanitizeTags(parseTagsFromText(text)) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'неизвестная ошибка';
    return { ok: false, reason: `Сеть или таймаут: ${msg}` };
  }
}

// ── Основная функция: теггинг одного изображения ─────────────
export async function tagTourImage(imageUrl: string): Promise<TourImageTags | null> {
  const r = await analyzeWithClaude(imageUrl);
  return r.ok ? r.tags : null;
}

const EMPTY_TAGS: TourImageTags = {
  landscape: [], activity: [], difficulty: 'moderate', season: [], features: [],
};

export interface TagTourPhotosResult {
  tags: TourImageTags;
  /** Сколько снимков реально дали теги. Ноль — теггинга не было. */
  analyzed: number;
  /** Сколько снимков пытались разобрать. */
  attempted: number;
  /** Причина, если не разобран ни один. Null — всё удалось. */
  reason: string | null;
}

// ── Теггинг всех фото тура (агрегированный результат) ─────────
export async function tagTourPhotos(photoUrls: string[]): Promise<TagTourPhotosResult> {
  const validUrls = photoUrls.filter((u) => u?.startsWith('http'));

  if (validUrls.length === 0) {
    return { tags: EMPTY_TAGS, analyzed: 0, attempted: 0, reason: 'Нет фотографий с корректным URL' };
  }

  // Анализируем первые 3 фото (экономим API запросы)
  const urlsToProcess = validUrls.slice(0, 3);
  const results: TourImageTags[] = [];
  const failures: string[] = [];

  for (const url of urlsToProcess) {
    const r = await analyzeWithClaude(url);
    if (r.ok) results.push(r.tags);
    else failures.push(r.reason);
    await new Promise((res) => setTimeout(res, 100)); // небольшая пауза
  }

  if (results.length === 0) {
    // Причина первого отказа: остальные, как правило, те же самые.
    return {
      tags: EMPTY_TAGS,
      analyzed: 0,
      attempted: urlsToProcess.length,
      reason: failures[0] ?? 'Не удалось разобрать ни один снимок',
    };
  }

  // Агрегируем: объединяем массивы и берём уникальные значения
  return {
    tags: {
      landscape: [...new Set(results.flatMap((r) => r.landscape))].slice(0, 5),
      activity: [...new Set(results.flatMap((r) => r.activity))].slice(0, 4),
      difficulty: results[0].difficulty, // берём из первого фото
      season: [...new Set(results.flatMap((r) => r.season))].slice(0, 4),
      features: [...new Set(results.flatMap((r) => r.features))].slice(0, 5),
    },
    analyzed: results.length,
    attempted: urlsToProcess.length,
    reason: null,
  };
}
