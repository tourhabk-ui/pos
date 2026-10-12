/**
 * GET /api/cron/model-knowledge-probe — знает ли модель о нас.
 *
 * Решение владельца 12.10 («го» на китайский слой для агентов). Вопрос «знают
 * ли китайские модели о Ведаре» до этого дня решался верой: в веса модели не
 * заглянуть, а «наверное, не знают» — не замер. Проба спрашивает каждую модель
 * БЕЗ поиска, только из того, что она помнит, что такое vedarai.ru / Ведар.
 *
 * В вопросе нет слова «Камчатка» ни на одном языке — намеренно: модель,
 * назвавшая Камчатку сама, знает нас, а не угадала по домену. Вопрос
 * по-китайски — как спросил бы турист из КНР.
 *
 * Три исхода (§4.0), и третий не равен второму:
 *   knows          — в ответе есть Камчатка (кириллицей, латиницей или 堪察加)
 *                    либо прежнее имя платформы: модель, назвавшая его сама,
 *                    знает нас под старым брендом (владелец 12.10: Qwen
 *                    отвечал про «TourHab», хотя мы давно Ведар); флаг
 *                    `old_brand` отдельный, чтобы это было видно;
 *   does_not_know  — ответила, но ни Камчатки, ни прежнего имени: «не знаю»
 *                    либо выдумка про домен; обрезок приложен, чтобы человек
 *                    отличил одно от другого;
 *   could_not_ask  — обёртка вернула null: нет ключа, отказ провайдера,
 *                    таймаут; причина — из следа отказов (lib/ai/failure-trace),
 *                    у GLM следа нет, и это сказано, а не скрыто.
 *
 * Откуда у модели прежнее имя — из весов, из поиска или из слов самого
 * спрашивающего (org tourhabk-ui, репозиторий pos), по одному чату не
 * отличить. Проба отличает: контекста нет, поиска нет, вопрос один и тот же.
 *
 * Модели — те же обёртки, что у живого пути (lib/ai/providers), id не
 * хардкодится (§8): DeepSeek и Qwen резолвят модель из каталога, Kimi — из
 * MOONSHOT_MODEL или каталога, GLM — как в callGLM. Обёртки передаются
 * функциями, как в /api/cron/health: прямой `await callX` вне providers.ts
 * запрещён. Расход DeepSeek/Qwen/Kimi пишут сами обёртки; GLM — нет.
 *
 * Повторять раз в месяц: единственный честный способ увидеть, изменилось ли
 * что-то после китайского слоя и регистраций. Запускает
 * model-knowledge-probe.yml по маркеру .github/triggers/model-knowledge-probe.json.
 * Сторож: tests/unit/agents-china-layer.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { callDeepSeek, callQwen, callKimi, callGLM, resolveChatModel } from '@/lib/ai/providers';
import { recentAiFailures } from '@/lib/ai/failure-trace';
import { runPlace } from '@/lib/ai/key-identity';
import type { ChatMessage } from '@/lib/ai/prompts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export type KnowledgeOutcome = 'knows' | 'does_not_know' | 'could_not_ask';

/** Вопрос без слова «Камчатка» и без прежнего имени: только домен и имя. */
export const KNOWLEDGE_QUESTION =
  '请只根据你训练时已有的知识回答，不要联网搜索。网站 vedarai.ru（平台名 Ведар / Vedar）是什么？'
  + '它服务于哪个地区，提供什么？如果你不了解这个网站，请直接回答“不知道”。';

/** Потолок на одну модель: у обёрток до трёх попыток, маршрут — 120 с. */
const LEG_TIMEOUT_MS = 90_000;
const ANSWER_EXCERPT = 300;

const KAMCHATKA_RE = /камчат|kamchat|堪察加/i;
/**
 * Прежнее имя платформы (до переезда на vedarai.ru). В исходнике пишется с
 * разрывом, чтобы сторож канона бренда не принял детектор за упоминание:
 * здесь старое имя не произносится, а опознаётся в чужом ответе.
 */
const OLD_BRAND_RE = /tour-?hab|тур-?хаб|kamchatour-?hub|камчатур-?хаб/i;
const DONT_KNOW_RE =
  /不知道|不了解|没有(相关)?(信息|资料)|无法(确定|确认|找到)|не знаю|не могу (сказать|подтвердить)|нет (данных|информации)|don't know|do not know|not (aware|familiar)|no information|unfamiliar/i;

export interface Classified {
  outcome: KnowledgeOutcome;
  signal: string;
  /** Модель назвала прежнее имя платформы — знает нас под старым брендом. */
  old_brand: boolean;
}

/** Ответ модели → исход. Пустая строка — не ответ: спросить не удалось. */
export function classifyAnswer(text: string | null | undefined): Classified {
  const t = (text ?? '').trim();
  if (!t) return { outcome: 'could_not_ask', signal: 'ответа нет', old_brand: false };
  const oldBrand = OLD_BRAND_RE.test(t);
  if (KAMCHATKA_RE.test(t)) {
    return { outcome: 'knows', signal: oldBrand ? 'назвала Камчатку и прежнее имя платформы' : 'назвала Камчатку сама', old_brand: oldBrand };
  }
  if (oldBrand) return { outcome: 'knows', signal: 'назвала прежнее имя платформы, Камчатку — нет: знает нас под старым брендом', old_brand: true };
  if (DONT_KNOW_RE.test(t)) return { outcome: 'does_not_know', signal: 'сказала, что не знает', old_brand: false };
  return { outcome: 'does_not_know', signal: 'ответила без Камчатки — смотреть обрезок: возможна выдумка про домен', old_brand: false };
}

interface ProbeLeg {
  provider: 'deepseek' | 'qwen' | 'kimi' | 'glm';
  keyEnv: string;
  call: (messages: ChatMessage[]) => Promise<string | null>;
  /** Метка провайдера в следе отказов; null — обёртка следа не пишет. */
  traceLabel: string | null;
  model: () => Promise<string | null>;
}

const LEGS: readonly ProbeLeg[] = [
  {
    provider: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', traceLabel: 'deepseek',
    call: (m) => callDeepSeek(m, { maxTokens: 300, timeoutMs: 45_000 }),
    model: () => resolveChatModel('deepseek'),
  },
  {
    provider: 'qwen', keyEnv: 'DASHSCOPE_API_KEY', traceLabel: 'qwen',
    call: (m) => callQwen(m, { maxTokens: 300 }),
    model: () => resolveChatModel('qwen'),
  },
  {
    provider: 'kimi', keyEnv: 'MOONSHOT_API_KEY', traceLabel: 'kimi',
    call: (m) => callKimi(m, { maxTokens: 300, timeoutMs: 45_000 }),
    model: async () => process.env.MOONSHOT_MODEL ?? null,
  },
  {
    provider: 'glm', keyEnv: 'GLM_API_KEY', traceLabel: null,
    call: (m) => callGLM(m),
    model: async () => null,
  },
];

export interface LegResult {
  provider: ProbeLeg['provider'];
  /** Модель, как её резолвит обёртка; null — обёртка имени не отдаёт. */
  model: string | null;
  outcome: KnowledgeOutcome;
  signal: string;
  old_brand: boolean;
  /** Для could_not_ask — почему; иначе null. */
  reason: string | null;
  latency_ms: number;
  answer_excerpt: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Последняя причина отказа провайдера из кольца следа — за время этого вызова. */
function lastFailure(label: string, sinceMs: number): string | null {
  const entries = recentAiFailures(Date.now() - sinceMs + 1_000)
    .filter((e) => e.provider === label || e.provider.startsWith(`${label}:`));
  return entries.length ? entries[entries.length - 1].reason : null;
}

async function askLeg(leg: ProbeLeg): Promise<LegResult> {
  const started = Date.now();
  let model: string | null = null;
  try {
    model = await leg.model();
  } catch (err) {
    console.error(`[model-knowledge-probe] ${leg.provider}: модель не резолвится:`, err instanceof Error ? err.message : err);
  }
  if (!process.env[leg.keyEnv]) {
    return {
      provider: leg.provider, model, outcome: 'could_not_ask', signal: 'ключа нет', old_brand: false,
      reason: `${leg.keyEnv} не задан — спросить нечем`, latency_ms: 0, answer_excerpt: null,
    };
  }
  const messages: ChatMessage[] = [{ role: 'user', content: KNOWLEDGE_QUESTION }];
  const answer = await withTimeout(leg.call(messages).catch((err: unknown) => {
    console.error(`[model-knowledge-probe] ${leg.provider}: обёртка бросила:`, err instanceof Error ? err.message : err);
    return null;
  }), LEG_TIMEOUT_MS);
  const latency = Date.now() - started;
  if (answer === 'timeout') {
    return {
      provider: leg.provider, model, outcome: 'could_not_ask', signal: 'ответа нет', old_brand: false,
      reason: `таймаут ${LEG_TIMEOUT_MS / 1000} с`, latency_ms: latency, answer_excerpt: null,
    };
  }
  const { outcome, signal, old_brand } = classifyAnswer(answer);
  let reason: string | null = null;
  if (outcome === 'could_not_ask') {
    reason = leg.traceLabel
      ? (lastFailure(leg.traceLabel, started) ?? 'обёртка вернула null, в следе отказов причины нет')
      : 'обёртка вернула null; callGLM след отказов не пишет — причина не записана';
  }
  return {
    provider: leg.provider, model, outcome, signal, old_brand, reason, latency_ms: latency,
    answer_excerpt: answer ? answer.trim().slice(0, ANSWER_EXCERPT) : null,
  };
}

export interface Summary extends Record<KnowledgeOutcome, string[]> {
  /** Кто назвал прежнее имя платформы — знает нас под старым брендом. */
  old_brand: string[];
}

export function summarize(legs: readonly LegResult[]): Summary {
  const s: Summary = { knows: [], does_not_know: [], could_not_ask: [], old_brand: [] };
  for (const l of legs) {
    s[l.outcome].push(l.provider);
    if (l.old_brand) s.old_brand.push(l.provider);
  }
  return s;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const askedAt = new Date().toISOString();
  const legs = await Promise.all(LEGS.map(askLeg));
  const summary = summarize(legs);
  // Проба не состоялась только когда спросить не удалось НИКОГО: «не знает»
  // — законный результат замера, а не поломка.
  const asked = legs.length - summary.could_not_ask.length;

  return NextResponse.json({
    ok: asked > 0,
    error: asked > 0 ? null : 'ни одну модель спросить не удалось — замера нет',
    place: runPlace(),
    asked_at: askedAt,
    question: KNOWLEDGE_QUESTION,
    legs,
    summary,
    verdict: `знают: ${summary.knows.join(', ') || '—'}; не знают: ${summary.does_not_know.join(', ') || '—'}; `
      + `спросить не удалось: ${summary.could_not_ask.join(', ') || '—'}`
      + (summary.old_brand.length ? `; под прежним именем платформы: ${summary.old_brand.join(', ')}` : ''),
  });
}
