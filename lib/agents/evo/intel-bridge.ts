/**
 * Мост Разведка → Эволюция.
 *
 * Проблема: Scout Digest (lib/agents/scout-digest.ts) каждый день читает RSS
 * (AI, туриндустрия, Камчатка), синтезирует дайджест и... отправляет его в
 * Telegram человеку. Развед-данные о внешнем мире НЕ возвращались в петлю
 * эволюции — «глаза наружу» и «руки внутри» не разговаривали.
 *
 * Этот мост читает последний дайджест Scout (из agent_knowledge, куда Scout уже
 * его кладёт), извлекает 0-2 КОНКРЕТНЫЕ, применимые к нашей платформе
 * возможности и заводит их как находки категории 'intel' в evo_growth_issues
 * (status 'suggested', severity 'medium'). Рука-репортёр (issue-reporter) затем
 * выносит их в GitHub Issues наравне с код-находками — решение остаётся за
 * человеком.
 *
 * Честность: извлекаем только то, что ЗАЗЕМЛЕНО в тексте дайджеста; кап 2/прогон;
 * дедуп по заголовку и по слагу дайджеста (один дайджест обрабатываем один раз).
 */

import { pool } from '@/lib/db-pool';
import { callAIDecision } from '@/lib/ai/providers';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface IntelProposal {
  title: string;
  description: string;
  suggestion: string;
}

export interface IntelBridgeResult {
  bridged: number;
  digest_slug: string | null;
  skipped: boolean;
  duration_ms: number;
}

const MAX_INTEL_PER_RUN = 2;

// Отговорки/пустышки модели — не задачи.
const INTEL_GARBAGE = /^(нет|ничего|не найдено|no |none|n\/a|отсутств)/i;

/**
 * Разбор ответа модели в список предложений. Чистая функция — под тестом.
 * Терпима к ```json-обёртке; отбрасывает пустые/мусорные/сверхдлинные заголовки.
 */
export function parseIntelProposals(raw: string | null): IntelProposal[] {
  if (!raw) return [];
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  let arr: unknown;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: IntelProposal[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    const suggestion = typeof o.suggestion === 'string' ? o.suggestion.trim() : '';
    if (title.length < 4 || title.length > 180) continue;
    if (!description || !suggestion) continue;
    if (INTEL_GARBAGE.test(title)) continue;
    out.push({ title, description, suggestion });
  }
  return out;
}

interface DigestRow { slug: string; compiled_truth: string }

async function latestScoutDigest(): Promise<DigestRow | null> {
  try {
    const { rows } = await pool.query<DigestRow>(
      `SELECT slug, compiled_truth
         FROM agent_knowledge
        WHERE agent_id = 'scout' AND type = 'intel' AND slug LIKE 'intel/scout/%'
        ORDER BY slug DESC
        LIMIT 1`,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `Ты аналитик развития туристической платформы Ведар (Камчатка, главная цель — безопасность туристов; офлайн-карта, SOS, маршруты, ИИ-помощник Кузьмич). Тебе дают ежедневный разведдайджест (AI-технологии, туриндустрия РФ, новости Камчатки).

Извлеки КОНКРЕТНЫЕ возможности для НАШЕЙ платформы — что стоит рассмотреть или внедрить. Строго:
- Только то, что ЗАЗЕМЛЕНО в тексте дайджеста. Ничего не выдумывай, не переноси цифры.
- Только применимое к нам: безопасность туристов, маршруты/точки, бронирование, ИИ-помощник, офлайн, привлечение туристов на Камчатку.
- Не «прочитать статью», а действие для платформы.
- Если ничего по-настоящему применимого нет — верни пустой массив. Пустой ответ лучше выдуманного.

Верни СТРОГО JSON-массив (без markdown), максимум 2 элемента:
[{"title":"задача ≤8 слов","description":"что во внешнем мире произошло и почему релевантно нам (по тексту дайджеста)","suggestion":"что конкретно рассмотреть/сделать на платформе"}]`;

/** Мост: последний дайджест Scout → до 2 находок 'intel' в evo_growth_issues. */
export async function bridgeScoutIntel(): Promise<IntelBridgeResult> {
  const startedAt = Date.now();
  const digest = await latestScoutDigest();
  if (!digest) {
    return { bridged: 0, digest_slug: null, skipped: true, duration_ms: Date.now() - startedAt };
  }

  // Один дайджест обрабатываем один раз (evo-крон бежит каждые 6ч, дайджест — раз в сутки)
  const recalled = await agentMemory.recall('evo', 'intel_bridge', 1).catch(() => []);
  const lastSlug = (recalled[0]?.value as { slug?: string } | undefined)?.slug;
  if (lastSlug === digest.slug) {
    return { bridged: 0, digest_slug: digest.slug, skipped: true, duration_ms: Date.now() - startedAt };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Дайджест (${digest.slug}):\n\n${digest.compiled_truth.slice(0, 6000)}` },
  ];

  let proposals: IntelProposal[] = [];
  try {
    proposals = parseIntelProposals(await callAIDecision(messages)).slice(0, MAX_INTEL_PER_RUN);
  } catch {
    proposals = [];
  }

  let bridged = 0;
  for (const p of proposals) {
    // Дедуп по заголовку среди активных находок
    const { rows: existing } = await pool.query<{ id: string }>(
      `SELECT id FROM evo_growth_issues
        WHERE status NOT IN ('rejected', 'ignored') AND title = $1
        LIMIT 1`,
      [p.title],
    );
    if (existing.length > 0) continue;

    await pool.query(
      `INSERT INTO evo_growth_issues (category, severity, title, description, suggestion, status)
       VALUES ('intel', 'medium', $1, $2, $3, 'suggested')`,
      [p.title, p.description, p.suggestion],
    );
    bridged++;
  }

  // Помечаем дайджест обработанным (даже если 0 находок — не долбим один и тот же)
  await agentMemory.remember({
    agent_id: 'evo',
    memory_type: 'intel_bridge',
    key: 'last_bridged',
    value: { slug: digest.slug, bridged },
    source: 'intel_bridge',
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }).catch(() => { /* некритично */ });

  return { bridged, digest_slug: digest.slug, skipped: false, duration_ms: Date.now() - startedAt };
}
