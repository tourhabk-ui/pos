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
 * Честность: извлекаем только то, что ЗАЗЕМЛЕНО в тексте дайджеста; кап на
 * прогон; один дайджест обрабатываем один раз (слаг в agent_memory); дедуп —
 * по ТЕМЕ (intelSignature), а не по строке заголовка: перефразированная тема
 * не проходит ни мимо активной находки, ни мимо отказа человека.
 */

import { pool } from '@/lib/db-pool';
import { callAIDecision } from '@/lib/ai/providers';
import { intelSignature } from '@/lib/agents/evo/claim-signature';
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

const MAX_INTEL_PER_RUN = 3;

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

/** Последний дайджест внешней разведки Scout (для контекста рассуждений эво). */
export async function latestScoutDigest(): Promise<DigestRow | null> {
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

const SYSTEM_PROMPT = `Ты аналитик развития туристической платформы Ведар (Камчатка, главная цель — безопасность туристов; офлайн-карта, SOS, маршруты, ИИ-помощник Кузьмич). Тебе дают ежедневный разведдайджест с разделами: AI-технологии, туриндустрия РФ, референсы и рынок (передовые travel-tech продукты — Skift, Product Hunt, конкуренты), новости Камчатки.

Извлеки КОНКРЕТНЫЕ возможности для НАШЕЙ платформы — что стоит рассмотреть или внедрить. Строго:
- Только то, что ЗАЗЕМЛЕНО в тексте дайджеста. Ничего не выдумывай, не переноси цифры.
- Только применимое к нам: безопасность туристов, маршруты/точки, бронирование, ИИ-помощник, офлайн, привлечение туристов на Камчатку.
- Не «прочитать статью», а действие для платформы.
- РАЗНООБРАЗИЕ: не бери оба-три слота на одну тему. Если в дайджесте есть достойные сигналы из «Референсов/рынка» или «Туриндустрии» — включи их, а не только AI-технологии (их обычно больше по объёму, но это не повод игнорировать фичи референсов и рыночные сигналы).
- Если ничего по-настоящему применимого нет — верни пустой массив. Пустой ответ лучше выдуманного.

Верни СТРОГО JSON-массив (без markdown), максимум 3 элемента:
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

  // Дедуп по ТЕМЕ, а не по строке заголовка. Прежний `WHERE title = $1`
  // ловил только дословный повтор, а модель приносит одну тему из каждого
  // дайджеста в новых словах — трекер заполнялся перефразировками
  // (та же болезнь, что у код-претензий до claim-signature).
  //
  // Стоп-лист — ВСЯ история intel, любой статус:
  //   · активная      → тема уже в работе, дубль не нужен;
  //   · rejected      → человек отказал, перефразировка не переиграет отказ;
  //   · fixed         → уже сделано, предлагать заново нечего.
  const { rows: prior } = await pool.query<{ title: string; description: string | null; suggestion: string | null; status: string }>(
    `SELECT title, description, suggestion, status FROM evo_growth_issues WHERE category = 'intel'`,
  );
  const known = new Set(prior.map((r) => intelSignature(r)));

  // Темы с историей — модели В ПРОМПТ, а не только в дедуп после ответа.
  // Дедуп срезает повтор, но слот из трёх уже потрачен; скажем заранее —
  // модель потратит слоты на новое. Только классифицированные темы: список
  // 'other'-заголовков разросся бы без пользы.
  const knownTopics = [...new Set(
    prior.map((r) => intelSignature(r))
      .filter((sig) => !sig.startsWith('intel::other:'))
      .map((sig) => sig.replace('intel::', '')),
  )];

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        (knownTopics.length > 0
          ? `Темы, по которым уже есть находка или вердикт владельца — НЕ предлагай их снова ни в какой формулировке: ${knownTopics.join(', ')}.\n\n`
          : '') +
        `Дайджест (${digest.slug}):\n\n${digest.compiled_truth.slice(0, 6000)}`,
    },
  ];

  let proposals: IntelProposal[] = [];
  try {
    proposals = parseIntelProposals(await callAIDecision(messages)).slice(0, MAX_INTEL_PER_RUN);
  } catch {
    proposals = [];
  }


  let bridged = 0;
  for (const p of proposals) {
    const sig = intelSignature(p);
    if (known.has(sig)) continue;
    known.add(sig); // и внутри одного прогона два слота не уходят на одну тему

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
