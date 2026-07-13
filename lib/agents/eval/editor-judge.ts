/**
 * lib/agents/eval/editor-judge.ts
 *
 * LLM-as-judge для качества описаний Editor (Roitman §14.7).
 * Smoke/regression проверяют, что описание ЕСТЬ и нужной длины — но не что оно
 * хорошее и достоверное. Судья оценивает содержательность + faithfulness
 * (главное для safety-платформы: штраф за выдуманную конкретику и факты безопасности).
 *
 * Митигация смещений (§14.7.2):
 *  - reference-guided pointwise: судье даём исходные факты (title/тип/имеющееся описание);
 *  - reasoning ПЕРЕД вердиктом (chain-of-thought) — снижает поверхностные оценки;
 *  - явный антиverbosity: длина ≠ качество, штраф за «воду» и выдуманные числа.
 *
 * Eval-only: используется регрессионным харнессом, в живой Editor не вмешивается.
 */

import { callAIFast, callAIWaterfall, isWaterfallErrorResponse } from '@/lib/ai/providers';
import type { RouteRow } from '@/lib/agents/editor';

export interface JudgeVerdict {
  score: number | null; // 1..5, null если судья недоступен/не распарсился
  reason: string;
}

/** Извлекает балл 1..5 из ответа судьи. Сначала JSON {score}, затем одиночная цифра. */
export function parseJudgeScore(raw: string): number | null {
  if (!raw) return null;
  const j = raw.match(/\{[\s\S]*\}/);
  if (j) {
    try {
      const obj = JSON.parse(j[0]) as { score?: unknown };
      const n = typeof obj.score === 'number' ? obj.score : Number(obj.score);
      if (Number.isFinite(n)) return Math.min(5, Math.max(1, Math.round(n)));
    } catch { /* fall through */ }
  }
  const m = raw.match(/\b([1-5])\b/);
  return m ? parseInt(m[1], 10) : null;
}

const JUDGE_SYSTEM = `Ты — строгий редактор-оценщик описаний туробъектов Камчатки для safety-платформы.
Оцени КАЧЕСТВО описания по шкале 1..5:
5 — содержательно, достоверно, без выдумок; 3 — приемлемо, но общо/слабо; 1 — пусто, шаблонно или с выдуманными фактами.

ЖЁСТКО штрафуй (макс. 2 балла):
- выдуманную конкретику, которой нет в исходных данных (высота, координаты, длина, перепад, температура, расстояния);
- выдуманные факты безопасности (броды, лавины, камнепады, «безопасно для новичков», активность вулкана);
- рекламные штампы и «воду» без содержания.
Длина НЕ повышает балл — оценивай содержательность и достоверность.

Сначала кратко рассуждай (1-2 предложения), затем верни СТРОГО JSON последней строкой:
{"score": 1-5, "reason": "<кратко>"}`;

/**
 * Оценка судьёй с фоллбэком провайдера (общий для editor и kuzmich грейдеров).
 * Попытка 1 — быстрый набор `callAIFast` (DeepSeek/Gemini/OpenRouter). Если он
 * недоступен, вернул sentinel-заглушку («Сервис временно недоступен») или ответ
 * без распознаваемого балла — добираем полным `callAIWaterfall` (Tier-1
 * GLM/Nvidia/Groq/Cerebras/Mistral, Tier-2 Yandex/MiniMax, Tier-3 Anthropic),
 * то есть ДРУГИМ набором провайдеров. score=null возвращаем только когда ОБА
 * набора не дали валидного балла — тогда «судья недоступен» честно означает
 * системный сбой, а не единичный отказ одного быстрого провайдера.
 * Fail-soft: любое исключение проглатывается, харнесс не падает.
 */
export async function judgeWithFallback(system: string, user: string): Promise<JudgeVerdict> {
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];

  // Попытка 1 — быстрый набор.
  try {
    const raw = await callAIFast(messages);
    if (raw && !isWaterfallErrorResponse(raw)) {
      const score = parseJudgeScore(raw);
      if (score !== null) return { score, reason: raw.slice(0, 200) };
    }
  } catch { /* переходим к фоллбэку */ }

  // Попытка 2 — полный waterfall (другой набор провайдеров, включая Anthropic).
  try {
    const raw = await callAIWaterfall(messages);
    if (raw && !isWaterfallErrorResponse(raw)) {
      const score = parseJudgeScore(raw);
      if (score !== null) return { score, reason: raw.slice(0, 200) };
    }
  } catch { /* исчерпали провайдеров */ }

  return { score: null, reason: 'судья недоступен (fast+waterfall)' };
}

/**
 * Оценивает одно сгенерированное описание относительно исходных фактов маршрута.
 * Fail-soft: при сбое AI/парсинга возвращает score=null (не валит харнесс).
 */
export async function judgeDescription(route: RouteRow, text: string): Promise<JudgeVerdict> {
  if (!text || !text.trim()) return { score: 1, reason: 'пустое описание' };

  const user = `ИСХОДНЫЕ ФАКТЫ (только это достоверно):
Название: ${route.title}
Тип: ${route.category ?? 'не указан'}
Имеющееся описание: ${route.description ? route.description.slice(0, 800) : 'нет'}

ОЦЕНИВАЕМОЕ ОПИСАНИЕ:
${text.slice(0, 2000)}`;

  return judgeWithFallback(JUDGE_SYSTEM, user);
}
