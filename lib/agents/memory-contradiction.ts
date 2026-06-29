/**
 * lib/agents/memory-contradiction.ts
 *
 * Детектор противоречий в памяти (Roitman §17.4.1 — contradiction detection).
 *
 * Цель — БЕЗОПАСНОСТЬ: разные сигналы могут утверждать несовместимое об одном
 * объекте («тропа открыта» vs свежее «тропа закрыта», «вертолёты летают» vs
 * «рейсы отменены», «безопасно» vs «сошла лавина»). Устаревший/ошибочный факт
 * о безопасности опасен для туриста.
 *
 * Реализация — ПЕРИОДИЧЕСКИЙ сканер (НЕ хук в hot write-path: запись памяти не
 * блокируем и не замедляем). Читает свежие разведсигналы + инсайты, находит
 * ПРЯМЫЕ противоречия, флагует в agent_knowledge (type='contradiction') и при
 * высокой severity шлёт алерт админу. Полностью аддитивно.
 *
 * Анти-ложные-срабатывания: промпт требует ТОЛЬКО прямые несовместимые пары об
 * одном субъекте; при сомнении — ничего не возвращать.
 */

import { z } from 'zod';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { callAIWaterfall } from '@/lib/ai/providers';
import { formatEpisodesForSynthesis } from '@/lib/agents/memory-reflector';
import type { ChatMessage } from '@/lib/ai/prompts';

const AGENT_ID = 'memory-contradiction';
const MAX_EPISODES = 40;
const MAX_INSIGHTS = 20;
const MAX_FLAGS = 10;

const ContradictionSchema = z.object({
  subject: z.string().min(2),
  statement_a: z.string().min(3),
  statement_b: z.string().min(3),
  severity: z.enum(['low', 'medium', 'high']),
  why: z.string().min(3),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export interface ContradictionResult {
  scanned: number;
  contradictions: number;
  alerted: number;
  reason?: string;
}

// ── Чистые помощники ─────────────────────────────────────────────────────────

/** Извлекает и валидирует массив противоречий из ответа AI. Битый/пустой → []. */
export function parseContradictions(raw: string): Contradiction[] {
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
  const out: Contradiction[] = [];
  for (const item of arr) {
    const parsed = ContradictionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= MAX_FLAGS) break;
  }
  return out;
}

const SCAN_PROMPT = `Ты — аудитор безопасности туристической платформы. Тебе дают набор утверждений
(разведсигналы + накопленные выводы). Найди ПРЯМЫЕ противоречия — пары утверждений
об ОДНОМ И ТОМ ЖЕ объекте/маршруте/услуге, которые НЕ МОГУТ быть истинны одновременно.

Примеры противоречий: открыто/закрыто, доступно/недоступно, безопасно/опасно,
рейсы есть/отменены, цена X / цена Y для одного и того же.

СТРОГО:
- Только ПРЯМЫЕ несовместимые пары об одном субъекте. Разные субъекты — не противоречие.
- Не выдумывай. Сомневаешься — не включай.
- severity: high если касается БЕЗОПАСНОСТИ или доступа на маршрут; medium — деньги/логистика; low — прочее.

Верни ТОЛЬКО JSON-массив (пустой [], если противоречий нет):
[{"subject":"что","statement_a":"...","statement_b":"...","severity":"low|medium|high","why":"кратко"}]`;

async function tgAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}

// ── Оркестратор ──────────────────────────────────────────────────────────────

export async function runContradictionScan(): Promise<ContradictionResult> {
  const episodes = await agentMemory.recallShared('intelligence', MAX_EPISODES);
  const insightPages = await knowledgeBase.list({ type: 'insight', limit: MAX_INSIGHTS }).catch(() => []);

  const memText = formatEpisodesForSynthesis(episodes);
  const insightText = insightPages
    .map(p => `[вывод] ${p.title}: ${(p.compiled_truth ?? '').slice(0, 200)}`)
    .join('\n');
  const corpus = [memText, insightText].filter(Boolean).join('\n');
  const scanned = episodes.length + insightPages.length;

  if (corpus.trim().length < 80) {
    return { scanned, contradictions: 0, alerted: 0, reason: 'insufficient_corpus' };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SCAN_PROMPT },
    { role: 'user', content: corpus.slice(0, 12_000) },
  ];

  let raw = '';
  try {
    raw = await callAIWaterfall(messages);
  } catch {
    return { scanned, contradictions: 0, alerted: 0, reason: 'ai_unavailable' };
  }

  const found = parseContradictions(raw);
  if (found.length === 0) {
    return { scanned, contradictions: 0, alerted: 0 };
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  let alerted = 0;
  for (let i = 0; i < found.length; i++) {
    const c = found[i];
    await knowledgeBase.upsert({
      slug: `contradiction/${dateKey}/${i}`,
      type: 'contradiction',
      title: `Противоречие: ${c.subject}`.slice(0, 200),
      compiled_truth: `A: ${c.statement_a}\nB: ${c.statement_b}\n\nПочему несовместимо: ${c.why}\n[severity: ${c.severity}; обнаружено: ${dateKey}]`,
      metadata: { severity: c.severity, subject: c.subject, detected_at: dateKey },
      agent_id: AGENT_ID,
    });

    if (c.severity === 'high') {
      await tgAlert(
        `<b>Противоречие в данных (safety)</b>\n` +
        `Объект: ${c.subject}\n` +
        `A: ${c.statement_a}\nB: ${c.statement_b}\n` +
        `${c.why}\nПроверьте актуальность перед выдачей туристу.`,
      );
      alerted++;
    }
  }

  return { scanned, contradictions: found.length, alerted };
}
