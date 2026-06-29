/**
 * lib/agents/memory-reflector.ts
 *
 * Рефлектор памяти (Roitman §17.4.4 — memory consolidation, эпизод→семантика).
 *
 * Проблема: эпизодические разведсигналы в agent_memory (memory_type='intelligence',
 * из TG-мониторинга) живут 3-7 дней и ИСТЕКАЮТ. Повторяющиеся паттерны теряются.
 *
 * Решение: периодически синтезируем из эпизодов durable-инсайты в agent_knowledge
 * (постоянное семантическое хранилище, читается всеми агентами через брифинг).
 *
 * Анти-галлюцинация (safety-critical платформа): синтез ТОЛЬКО из переданных
 * сигналов. Промпт запрещает выдумывать факты. Сырьё — источник истины.
 *
 * Полностью аддитивный модуль: ничего существующего не меняет, только пишет
 * новые insight-страницы. Smoke-test подтверждает реальную запись в БД.
 */

import { z } from 'zod';
import { agentMemory, type MemoryEntry } from '@/lib/agents/memory/agent-memory';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { callAIWaterfall } from '@/lib/ai/providers';
import { smokeTestKnowledgeWrites } from '@/lib/agents/smoke-test';
import type { ChatMessage } from '@/lib/ai/prompts';

const AGENT_ID = 'memory-reflector';
const MIN_EPISODES = 3;       // меньше — нечего обобщать
const MAX_EPISODES = 50;      // верхняя граница на прогон
const MAX_INSIGHTS = 8;       // не плодить страницы без меры

const InsightSchema = z.object({
  title: z.string().min(4),
  insight: z.string().min(10),
  category: z.enum(['demand', 'pricing', 'competitor', 'operations', 'risk', 'trend', 'other']),
  confidence: z.number().min(0).max(1),
});
export type InsightDraft = z.infer<typeof InsightSchema>;

export interface ReflectorResult {
  episodes_read: number;
  consolidated: number;
  smoke_passed: boolean;
  reason?: string;
}

// ── Чистые помощники (юнит-тестируемые) ──────────────────────────────────────

/** Компактно сериализует эпизоды для синтеза (только содержательные поля). */
export function formatEpisodesForSynthesis(entries: MemoryEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const v = (e.value ?? {}) as Record<string, unknown>;
    const title = typeof v.group_title === 'string' ? v.group_title : (e.key || 'сигнал');
    const when = typeof v.analyzed_at === 'string' ? v.analyzed_at.slice(0, 10)
      : (typeof v.timestamp === 'string' ? v.timestamp.slice(0, 10) : (e.updated_at ?? '').slice(0, 10));

    // hot-signal записи
    if (Array.isArray(v.signals) && v.signals.length > 0) {
      lines.push(`[${when}] ${title} — горячие сигналы: ${v.signals.map(String).join('; ')}`);
      continue;
    }
    // обычные intel записи
    const intel = v.intel as Record<string, unknown> | undefined;
    if (intel) {
      const parts: string[] = [];
      for (const [k, val] of Object.entries(intel)) {
        if (val == null) continue;
        const s = Array.isArray(val) ? val.map(String).join(', ') : String(val);
        if (s && s !== '[]' && s.trim()) parts.push(`${k}: ${s}`);
      }
      if (parts.length) lines.push(`[${when}] ${title} — ${parts.join(' | ')}`.slice(0, 400));
    }
  }
  return lines.join('\n');
}

/** Извлекает и валидирует массив инсайтов из ответа AI. Битый/пустой → []. */
export function parseInsights(raw: string): InsightDraft[] {
  if (!raw) return [];
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: InsightDraft[] = [];
  for (const item of arr) {
    const parsed = InsightSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= MAX_INSIGHTS) break;
  }
  return out;
}

const SYNTH_PROMPT = `Ты — аналитик туристической платформы. Тебе дают СЫРЫЕ разведсигналы из мониторинга
Telegram-каналов индустрии (спрос, цены, конкуренты, риски). Синтезируй из них устойчивые
ВЫВОДЫ (insights) — то, что повторяется или важно для решений платформы.

СТРОГО:
- Только из предоставленных сигналов. НИЧЕГО НЕ ВЫДУМЫВАЙ. Нет паттерна — меньше выводов.
- Каждый вывод опирается минимум на пару сигналов или один явно важный.
- confidence: 0.9 если сигнал повторяется/явный, 0.5 если единичный/косвенный.

Верни ТОЛЬКО JSON-массив:
[{"title":"кратко","insight":"что и почему важно платформе","category":"demand|pricing|competitor|operations|risk|trend|other","confidence":0.0-1.0}]`;

// ── Оркестратор ──────────────────────────────────────────────────────────────

export async function runMemoryReflector(): Promise<ReflectorResult> {
  const startedAt = new Date();

  const episodes = await agentMemory.recallShared('intelligence', MAX_EPISODES);
  if (episodes.length < MIN_EPISODES) {
    return { episodes_read: episodes.length, consolidated: 0, smoke_passed: true, reason: 'insufficient_episodes' };
  }

  const corpus = formatEpisodesForSynthesis(episodes);
  if (!corpus.trim()) {
    return { episodes_read: episodes.length, consolidated: 0, smoke_passed: true, reason: 'empty_corpus' };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYNTH_PROMPT },
    { role: 'user', content: corpus.slice(0, 12_000) },
  ];

  let raw = '';
  try {
    raw = await callAIWaterfall(messages);
  } catch {
    return { episodes_read: episodes.length, consolidated: 0, smoke_passed: true, reason: 'ai_unavailable' };
  }

  const insights = parseInsights(raw);
  if (insights.length === 0) {
    return { episodes_read: episodes.length, consolidated: 0, smoke_passed: true, reason: 'no_insights' };
  }

  const dateKey = startedAt.toISOString().slice(0, 10);
  let consolidated = 0;
  for (let i = 0; i < insights.length; i++) {
    const ins = insights[i];
    const page = await knowledgeBase.upsert({
      slug: `insight/${dateKey}/${i}`,
      type: 'insight',
      title: ins.title.slice(0, 200),
      compiled_truth: `${ins.insight}\n\n[категория: ${ins.category}; уверенность: ${ins.confidence}; источник: рефлексия ${episodes.length} разведсигналов ${dateKey}]`,
      metadata: { category: ins.category, confidence: ins.confidence, episodes: episodes.length, generated_at: dateKey },
      agent_id: AGENT_ID,
    });
    if (page) consolidated++;
  }

  const smoke = await smokeTestKnowledgeWrites(AGENT_ID, consolidated, startedAt);

  return { episodes_read: episodes.length, consolidated, smoke_passed: smoke.passed };
}
