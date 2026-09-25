/**
 * Shared AI provider functions — waterfall pattern.
 * MiMo-V2-Pro (Xiaomi) → OpenRouter (GPT-4o-mini) → xAI (Grok) → Anthropic (Haiku)
 *
 * Env vars:
 *   XIAOMI_API_KEY          — Xiaomi MiMo ($1/1M tokens, 1M context)
 *   OPENROUTER_API_KEY      — OpenRouter multi-model (GPT-4o-mini → DeepSeek → Claude Haiku)
 *   DEEPSEEK_API_KEY        — DeepSeek direct API
 *   GEMINI_API_KEY          — Google Gemini 2.0 Flash direct
 *   XAI_API_KEY             — xAI Grok-4 (geo-blocked RU)
 *   ANTHROPIC_API_KEY       — Claude Haiku direct (geo-blocked RU)
 *   MINIMAX_API_KEY         — Minimax (резерв)
 *   NVIDIA_API_KEY          — NVIDIA NIM (Llama 3.3-70B, бесплатно)
 *   GROQ_API_KEY            — Groq (Llama 3.3-70B, бесплатно, US — проверить geo)
 *   CEREBRAS_API_KEY        — Cerebras (Llama 3.3-70B, бесплатно, US — проверить geo)
 *   MISTRAL_API_KEY         — Mistral La Plateforme (бесплатно, EU — проверить geo)
 *
 *   EVO_DECISION_FLAGSHIP_MODEL — флагман-решатель эволюции через OpenRouter
 *                             (default anthropic/claude-opus-5). Достижим из РФ
 *                             ТОЛЬКО через OPENROUTER_BASE_URL-релей + OPENROUTER_API_KEY.
 *                             Не задан ключ/релей → падаем на DeepSeek/Qwen.
 *   EVO_DECISION_MODEL      — модель-решатель эволюции (DeepSeek, default: авторезолв из /v1/models)
 *   EVO_DECISION_QWEN_MODEL — фоллбэк-решатель (Qwen, default qwen-max-latest)
 *   QWEN_MODEL              — override модели Qwen. Без него callQwen резолвит
 *                             сильнейшую из /v1/models. Tools-цикл Кузьмича
 *                             (callQwenWithTools) берёт QWEN_MODEL как есть —
 *                             без резолва, ради задержки живого пути.
 *   OPENROUTER_BASE_URL     — необязательно: релей вне РФ для openrouter.ai
 *                             (по умолчанию https://openrouter.ai/api/v1)
 *   ANTHROPIC_BASE_URL      — необязательно: релей вне РФ для api.anthropic.com
 *                             (по умолчанию https://api.anthropic.com)
 *
 * Бесплатные провайдеры инертны без ключа (getter→null→ноль сокетов в гонке).
 * US/EU-провайдеры (Groq/Cerebras/Mistral) могут геоблокировать РФ-IP Timeweb —
 * перед тем как полагаться, проверить достижимость через /api/ai/debug-waterfall.
 *
 * Гео-обход: openrouter.ai и api.anthropic.com блокируют РФ-IP — флагманы тогда
 * недостижимы, waterfall падает на DeepSeek/Gemini. Задать OPENROUTER_BASE_URL/
 * ANTHROPIC_BASE_URL на релей вне РФ (Cloudflare Worker/VPS) — и флагманы снова
 * в строю. Ключи и заголовки форвардит релей как есть.
 */

import type { ChatMessage } from '@/lib/ai/prompts';
import { recordAiLegFailure, httpFailureReason, errorFailureReason, describeEmptyCompletion, reasoningAteTheAnswer } from '@/lib/ai/failure-trace';
import { refusalNote } from '@/lib/ai/refusal-notes';
import { getOpenRouterKey, getOpenRouterKeySource, describeOpenRouterKey, getMiMoKey, getDeepSeekKey, getAnthropicKey, getXaiKey, getGeminiKey, getYandexKey, getMiniMaxKey, getGLMKey, getMuseSparkKey, getNvidiaKey, getFuguKey, getGroqKey, getCerebrasKey, getMistralKey, getMoonshotKey, getTimewebAgents, type TimewebAgent } from '@/lib/ai/provider-config';
import { pool } from '@/lib/db-pool';
import { addUsage, currentAgentId } from '@/lib/ai/usage-context';
import { usageSinkEnabled, sendUsageToProd } from '@/lib/ai/usage-sink';
import { pickBestModel, pickBestFlagship, classifyModels } from '@/lib/ai/model-resolver';
import { runPlace, keyReport, type RunPlace, type KeyReport } from '@/lib/ai/key-identity';
import { openRouterAttribution } from '@/lib/ai/attribution';
import { isFreeQuotaExhausted, markFreeQuotaExhausted, isMarkedExhausted, exhaustedModels, freeQuotaSiblings, firstUnexhausted } from '@/lib/ai/qwen-free-quota';

// ── Региональный релей (обход гео-блокировок RU) ──────────────────────────
// Timeweb-хостинг в РФ: openrouter.ai и api.anthropic.com гео-блокируют РФ-IP,
// из-за чего флагманы (Fable 5, Opus, GPT) недостижимы, и waterfall молча
// падает на DeepSeek/Gemini. Если задан релей вне РФ (Cloudflare Worker/VPS —
// прозрачный прокси, форвардит путь и Authorization как есть), базовые URL
// указывают на него. Переменные не заданы → прежнее прямое поведение.
/** Домашний адрес OpenRouter — база по умолчанию и эталон для диагностики релея. */
const OPENROUTER_DIRECT = 'https://openrouter.ai/api/v1';
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || OPENROUTER_DIRECT).replace(/\/+$/, '');
// Экспортируется: прямой вызов Anthropic нужен там, где waterfall не годится
// (image-tagger — ему нужно зрение, а waterfall текстовый). Такие места обязаны
// брать базу отсюда, иначе релей их не спасёт и они останутся мертвы в РФ.
export const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

// ── LLM usage tracking ────────────────────────────────────────
// Logs token counts and estimated costs to llm_usage_log (migration 686).
// Fire-and-forget — never throws, never blocks the caller.

interface ProviderUsage { prompt_tokens?: number; completion_tokens?: number }

const COST_PER_1K: Record<string, number> = {
  'deepseek-chat':                             0.00050,
  'deepseek/deepseek-chat-v3-0324':            0.00050,
  'anthropic/claude-fable-5':                  0.01500,
  // Opus 5 — ВДВОЕ дешевле Fable 5: $5/$25 за млн против $10/$50
  // (анонс Anthropic 25.07.2026). До анонса цена стояла как у Opus 4.8, то
  // есть равной Fable 5, — это была догадка, и она завышала расход вдвое.
  // Таблица блендовая (одно число на 1К всех токенов); доля вывода в ней ~12.5%,
  // что и даёт 0.015 для Fable 5. Тот же бленд для вдвое меньших ставок — 0.0075.
  'anthropic/claude-opus-5':                   0.00750,
  // 4.8 оставлена: по ней считается стоимость исторических строк llm_usage_log.
  'anthropic/claude-opus-4-8':                 0.01500,
  'anthropic/claude-haiku-4-5-20251001':       0.00025,
  'anthropic/claude-haiku-4-5':                0.00025,
  'openai/gpt-4o-mini':                        0.00040,
  'meta-llama/llama-3.3-70b-instruct':         0.00020,
  'gemini-2.0-flash':                          0.00010,
  'google/gemini-2.0-flash-001':               0.00010,
  'mimo-v2-pro':                               0.00010,
  'glm-5.1':                                   0.00030,
  'llama-3.3-70b-versatile':                   0,        // Groq free tier
  'llama-3.3-70b':                             0,        // Cerebras free tier
  'mistral-small-latest':                      0,        // Mistral free tier
};

/**
 * Кто ОТВЕТИЛ, а не кого мы просили.
 *
 * OpenAI-совместимые ответы несут поле `model`, и оно может отличаться от
 * запрошенного: DeepSeek с 14.09 04:00 UTC (12:00 Пекина; уведомление 10.09
 * перенесло срок с 10.09) отдаёт V4.1 Flash на ЛЮБОЙ запрос к Pro и биллит
 * по Flash. Журнал, пишущий запрошенное
 * имя, с этого момента называет модель, которая не отвечала, — и делает это
 * ровно в той таблице, поверх которой строится админка с ценами.
 *
 * Поле отсутствует или пустое — остаётся запрошенное имя: это честное «не
 * сказали», а не подмена.
 */
function answeredModel(requested: string, data: unknown): string {
  if (data && typeof data === 'object' && 'model' in data) {
    const m = (data as { model?: unknown }).model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  }
  return requested;
}

/**
 * Откуда взята цена вызова — провенанс на КАЖДУЮ строку журнала (#1862,
 * решение владельца 14.09, карт-бланш). Историю задним числом не
 * пересчитываем («пересчёт задним числом — тоже вид выдумывания») — строки
 * до миграции 961 помечены отдельным значением самой миграцией, не этим кодом.
 */
type CostBasis = 'model_catalog' | 'cost_table_fallback' | 'unknown';

/**
 * Достижим ли каталог отсюда.
 *
 * Каталог живёт в БД. На раннере GitHub `DATABASE_URL` не задан вовсе, а БД
 * Timeweb оттуда закрыта файрволом — спрашивать НЕКОГО, и это известное
 * состояние, а не отказ (тот же четвёртый исход, что уровень `known` в
 * health-кроне, §8). Ходить туда ради гарантированного промаха значит платить
 * таймаутом соединения на каждый вызов модели и писать в лог тревогу, по
 * которой нечего чинить: 19.09 строка «каталог моделей не прочитан» увела
 * разбор немоты флагмана в сторону БД, хотя сломано было другое — расход
 * некуда было отправить.
 *
 * Цену на раннере считает прод, принимая строку расхода
 * (`POST /api/admin/llm-usage/report` зовёт эту же функцию у себя); потолку
 * прямого Anthropic хватает запаса `COST_PER_1K`, где Opus 5 есть.
 */
function priceCatalogReachable(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Цена вызова — из каталога моделей (миграция 946, цены OpenRouter,
 * привезённые раннером GitHub, потому что прод каталог не видит), а не из
 * захардкоженной таблицы. `COST_PER_1K` выше остаётся только ЗАПАСОМ для
 * моделей, которых в каталоге OpenRouter нет и быть не может (прямые
 * DeepSeek/Qwen/Timeweb вызовы). Промах в обоих источниках — `cost: null`,
 * не умолчание $0.0005: догадка — ровно то, из-за чего заведён #1862
 * (умолчание втрое завышало DeepSeek Flash и втрое с половиной занижало
 * GLM 5.3 — обе живые модели, ни одной из которых в старой таблице не было).
 */
export async function resolveCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<{ cost: number | null; basis: CostBasis }> {
  const candidates = priceLookupIds(model);
  if (!priceCatalogReachable()) return fromCostTable(candidates);
  try {
    for (const id of candidates) {
      const { rows } = await pool.query<{ usd_per_mtok_in: string | null; usd_per_mtok_out: string | null }>(
        `SELECT usd_per_mtok_in, usd_per_mtok_out FROM model_catalog WHERE model_id = $1 LIMIT 1`,
        [id],
      );
      const row = rows[0];
      if (row) {
        const inPrice = row.usd_per_mtok_in != null ? Number(row.usd_per_mtok_in) : null;
        const outPrice = row.usd_per_mtok_out != null ? Number(row.usd_per_mtok_out) : null;
        if (inPrice !== null && outPrice !== null && Number.isFinite(inPrice) && Number.isFinite(outPrice)) {
          return { cost: (promptTokens * inPrice + completionTokens * outPrice) / 1e6, basis: 'model_catalog' };
        }
      }
    }
  } catch (e) {
    // Каталог не спросился (сеть/БД) — не выдумываем цену, падаем на запас.
    console.error('[llm-usage] каталог моделей не прочитан:', model, e instanceof Error ? e.message : e);
  }
  return fromCostTable(candidates);

  function fromCostTable(ids: string[]): { cost: number | null; basis: CostBasis } {
    for (const id of ids) {
      if (id in COST_PER_1K) {
        return { cost: (COST_PER_1K[id] * (promptTokens + completionTokens)) / 1000, basis: 'cost_table_fallback' };
      }
    }
    // Промах в обоих источниках — честное «не знаем», а не подставленный ноль.
    return { cost: null, basis: 'unknown' };
  }
}

/**
 * Ключ журнала → идентификаторы, под которыми модель знают источники цен.
 *
 * Журнал пишет вендора ДВОЕТОЧИЕМ, когда вызов шёл не через OpenRouter:
 * `anthropic:claude-opus-5`, `qwen:qwen-plus`, `kimi:...`, `timeweb:<agent_id>`.
 * Оба источника цен — `model_catalog` (миграция 946, слаги OpenRouter) и запас
 * `COST_PER_1K` — знают форму с КОСОЙ ЧЕРТОЙ: `anthropic/claude-opus-5`.
 *
 * Разделители расходились молча, и расходился ровно САМЫЙ ДОРОГОЙ путь. Ступень
 * 0b решателя (прямой Anthropic) просит сильнейшую модель каталога Anthropic —
 * Opus 5, $5 вход / $25 выход за миллион, — а в книгах её строка лежала как
 * «цену не знаем»: `estimated_cost_usd` NULL. `SUM(estimated_cost_usd)` в
 * `/api/cron/llm-budget-check` NULL пропускает, то есть дневной бюджет не видел
 * этих трат вовсе и сработать по ним не мог. Пустой баланс ключа Anthropic
 * (19.09) пришёл именно оттуда: пока ключ OpenRouter лежал не в своём секрете,
 * ступень 0 отказывала на каждом вызове и весь решатель шёл через 0b.
 *
 * Нормализация МЕХАНИЧЕСКАЯ: та же строка, другой разделитель. Догадок о чужих
 * слагах здесь нет — если `vendor/model` не знает ни каталог, ни запас, цена
 * остаётся `null`, то есть честное «не знаем» (§4.0), а не подставленный ноль.
 */
export function priceLookupIds(loggedModel: string): string[] {
  const ids = [loggedModel];
  const sep = loggedModel.indexOf(':');
  if (sep > 0) {
    const vendor = loggedModel.slice(0, sep);
    const rest = loggedModel.slice(sep + 1);
    // Слаг вендора не содержит двоеточий и косых: `timeweb:<agent_id>` так и
    // останется неизвестным — у агента шлюза нет цены ни в одном каталоге, и
    // притворяться, что есть, значило бы выдумать её.
    if (rest && !rest.includes('/') && !rest.includes(':')) ids.push(`${vendor}/${rest}`);
  }
  return ids;
}

// ── Потолок прямого Anthropic (ступень 0b решателя) ───────────────
/**
 * Самая дорогая ступень включается сама, когда ломается дешёвая, — и 19.09
 * именно так кончился баланс ключа Anthropic.
 *
 * Механизм: ключ OpenRouter лежал не в своём секрете, значит ступень 0 (флагман
 * через OpenRouter, по решению владельца 09.09 — GLM 5.3 за $0.91/$2.86 за млн)
 * отказывала на КАЖДОМ вызове. Следом шла ступень 0b, а она просит сильнейшую
 * модель каталога Anthropic — Opus 5, $5/$25 за млн по каталогу того же дня.
 * Вход дороже в 5,5 раза, выход в 8,7. Решение об экономии отменялось молча и
 * на каждом вызове, потому что у запасного пути не было ни потолка, ни голоса.
 *
 * Потолок ДВОЙНОЙ, и второй — не перестраховка, а третий исход §4.0. Цену мы
 * знаем не всегда (`resolveCostUsd` честно возвращает null для моделей вне
 * каталога и запаса), а «цену не знаю» не должно означать «трать сколько
 * хочешь». Поэтому деньги ограничены суммой, а незнание — числом вызовов.
 *
 * Счётчики — на модуль, а не в AsyncLocalStorage: прогон крона и прогон
 * скрипта на раннере — это процесс, живущий одну задачу, и «за процесс» здесь
 * совпадает с «за прогон». Атрибуция по агенту уже есть в usage-context и
 * решает другую задачу — кто потратил, а не сколько осталось.
 *
 * Потолок НЕ меняет порядок ступеней (§8, решение владельца 04.08 «решатель
 * дипсик либо опус»): ступень остаётся на своём месте и в своей очереди. Он
 * ограничивает только СУММУ, и отказ по нему громкий — в лог и в provenance
 * отчёта, чтобы «судью понизило до дешёвой модели» нельзя было не заметить.
 */
const ANTHROPIC_DIRECT_DEFAULT_MAX_USD = 1.0;
const ANTHROPIC_DIRECT_DEFAULT_MAX_CALLS = 8;

let anthropicDirectSpentUsd = 0;
let anthropicDirectCalls = 0;
let anthropicDirectUnpricedCalls = 0;

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Мусор в переменной не должен НИ снимать потолок, ни ронять вызов: остаётся
  // умолчание, и о подмене сказано вслух.
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[ai-decision] ${name}=${raw} — не число: беру умолчание ${fallback}`);
    return fallback;
  }
  return n;
}

/** Пускать ли ещё один вызов прямого Anthropic — и если нет, то почему. */
export function anthropicDirectGate(): { allowed: boolean; reason: string } {
  const maxUsd = positiveEnvNumber('ANTHROPIC_DIRECT_MAX_USD', ANTHROPIC_DIRECT_DEFAULT_MAX_USD);
  const maxCalls = positiveEnvNumber('ANTHROPIC_DIRECT_MAX_CALLS', ANTHROPIC_DIRECT_DEFAULT_MAX_CALLS);

  if (anthropicDirectCalls >= maxCalls) {
    return {
      allowed: false,
      reason: `потолок прямого пути: ${anthropicDirectCalls} вызовов за прогон (предел ${maxCalls}, ANTHROPIC_DIRECT_MAX_CALLS)`,
    };
  }
  if (anthropicDirectSpentUsd >= maxUsd) {
    return {
      allowed: false,
      reason: `потолок прямого пути: $${anthropicDirectSpentUsd.toFixed(4)} за прогон (предел $${maxUsd}, ANTHROPIC_DIRECT_MAX_USD)`,
    };
  }
  return { allowed: true, reason: '' };
}

/**
 * Записывает стоимость состоявшегося вызова в счётчики потолка.
 *
 * Цена берётся ТЕМ ЖЕ источником, что и книги (`resolveCostUsd`) — иначе
 * потолок и отчёт расходились бы в числах, а расхождение двух счётчиков одного
 * факта здесь уже стоило дня разбора. Цены нет — вызов всё равно посчитан
 * штукой, и это отдельно видно в состоянии.
 */
export async function chargeAnthropicDirect(
  loggedModel: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  anthropicDirectCalls += 1;
  const { cost } = await resolveCostUsd(loggedModel, promptTokens, completionTokens);
  if (cost === null) {
    anthropicDirectUnpricedCalls += 1;
    return;
  }
  anthropicDirectSpentUsd += cost;
}

/** Состояние потолка — для диагностики и для тестов. */
export function anthropicDirectBudgetState(): {
  calls: number; spent_usd: number; unpriced_calls: number; max_usd: number; max_calls: number;
} {
  return {
    calls: anthropicDirectCalls,
    spent_usd: anthropicDirectSpentUsd,
    unpriced_calls: anthropicDirectUnpricedCalls,
    max_usd: positiveEnvNumber('ANTHROPIC_DIRECT_MAX_USD', ANTHROPIC_DIRECT_DEFAULT_MAX_USD),
    max_calls: positiveEnvNumber('ANTHROPIC_DIRECT_MAX_CALLS', ANTHROPIC_DIRECT_DEFAULT_MAX_CALLS),
  };
}

/** Сброс счётчиков — только для тестов: в проде процесс живёт один прогон. */
export function resetAnthropicDirectBudget(): void {
  anthropicDirectSpentUsd = 0;
  anthropicDirectCalls = 0;
  anthropicDirectUnpricedCalls = 0;
}

async function logLLMUsage(model: string, usage: ProviderUsage | undefined): Promise<void> {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = prompt + completion;
  if (total === 0) return;
  const { cost, basis } = await resolveCostUsd(model, prompt, completion);
  // Атрибуция вызывающему агенту (Roitman §18.7.4) — no-op вне
  // runWithUsageTracking (обычные HTTP-запросы Кузьмича), agent_id тогда NULL.
  // Неизвестная цена в аккумулятор идёт нулём: он копит ОЦЕНКУ одного прогона
  // для человека, а бухгалтерия — в llm_usage_log.estimated_cost_usd, где
  // NULL остаётся NULL, а не нулём (SUM(...) в /api/admin/llm-usage считает
  // известное отдельно от количества строк с неизвестной ценой).
  addUsage(prompt, completion, cost ?? 0);

  // Раннер GitHub в БД не достаёт (файрвол Timeweb), и прямой INSERT там падал
  // ВСЕГДА — а на раннере считают судья эволюции и AI-ревью, два самых дорогих
  // потребителя. Их расход не попадал в книги ни одной строкой, и дневной
  // бюджет (/api/cron/llm-budget-check) не мог по нему сработать. Там расход
  // уходит на прод роутом, который считает цену сам (lib/ai/usage-sink.ts).
  //
  // На проде `GITHUB_ACTIONS` не задан — прямой INSERT остаётся прежним, и
  // прод не звонит сам себе.
  if (usageSinkEnabled()) {
    void sendUsageToProd([{
      model, prompt_tokens: prompt, completion_tokens: completion, agent_id: currentAgentId(),
    }]);
    return;
  }

  pool.query(
    `INSERT INTO llm_usage_log
       (id, route, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, cost_basis, agent_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
    [model, prompt, completion, total, cost, basis, currentAgentId()],
  ).catch((e) => {
    // Отказ не глушится (§4.0): «не записали» не должно выглядеть как «не тратили».
    console.error('[llm-usage] строка не записана:', model, e instanceof Error ? e.message : e);
  });
}

/**
 * Расход синтеза речи (голос Кузьмича, #1992) — в те же книги, что текст.
 * DashScope считает синтез токенами ввода/вывода; цены синтеза в каталоге нет,
 * и строка ляжет с cost NULL: бюджет увидит «цена неизвестна», а не ноль.
 * false — провайдер usage не отдал, и вызывающий обязан сказать это вслух.
 */
export async function logSpeechUsage(model: string, usage: unknown): Promise<boolean> {
  const u = (usage ?? null) as { input_tokens?: unknown; output_tokens?: unknown } | null;
  const prompt = typeof u?.input_tokens === 'number' ? u.input_tokens : 0;
  const completion = typeof u?.output_tokens === 'number' ? u.output_tokens : 0;
  if (prompt + completion === 0) return false;
  await logLLMUsage(`qwen-tts:${model}`, { prompt_tokens: prompt, completion_tokens: completion });
  return true;
}

// ── Retry с exponential backoff + jitter (Roitman §18.7.1) ────
// Транзиентный 429/5xx или сетевой сбой у провайдера раньше выбивал модель
// из цепочки без повтора — падаем сразу на следующую, часто более дорогую.
// Ретраит ТОЛЬКО транзиентное: 429/500/502/503/504, ECONNRESET/ETIMEDOUT/
// "fetch failed". НЕ ретраит: 400 (кроме уже существующей safety-block ветки
// в callAnthropic — она вне этого хелпера, не трогаем), 401/403 (у OpenRouter
// уже есть markOpenRouterAuthFailure — не дублируем cooldown), 404, и
// AbortError от намеренного таймаута (это НЕ транзиентный сбой, а бюджет
// времени, который вызывающий код сам заложил).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|network/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Последняя причина отказа по каждому провайдеру.
 *
 * Зачем: провайдеры устроены одинаково — `if (!res.ok) return null` и
 * `catch { return null }`. Причина не сохраняется НИГДЕ, поэтому на вопрос
 * «почему сервис недоступен, ключ и баланс на месте» ответить было нечем:
 * в логе есть только перечень настроенных ключей, то есть «ключ есть»,
 * а не «что ответил провайдер».
 *
 * Пишется здесь, а не в пятнадцати вызовах: через fetchWithRetry ходят все,
 * и у неё уже есть label с именем провайдера.
 *
 * Тело ответа НЕ читается — его должен получить вызывающий. Одного статуса
 * хватает, чтобы различить основные случаи: 401 — ключ, 402 — кончился
 * баланс (так отвечает DeepSeek), 429 — лимит, 400 — устаревший model-id,
 * 403 — гео-блок.
 */
interface ProviderFailure { at: number; reason: string }
const lastProviderFailure = new Map<string, ProviderFailure>();

function noteProviderFailure(label: string | undefined, reason: string): void {
  if (!label) return;
  lastProviderFailure.set(label, { at: Date.now(), reason });
}

/** Свежие отказы провайдеров — для логов и health. Ключ: label провайдера. */
export function recentProviderFailures(maxAgeMs = 10 * 60_000): Record<string, string> {
  const out: Record<string, string> = {};
  const now = Date.now();
  for (const [label, f] of lastProviderFailure) {
    if (now - f.at <= maxAgeMs) {
      out[label] = `${f.reason} (${Math.round((now - f.at) / 1000)}с назад)`;
    }
  }
  return out;
}

/**
 * fetch с ретраями транзиентных сбоев. timeoutMs задаётся отдельным
 * параметром (не через init.signal) — каждая попытка получает свежий
 * AbortSignal.timeout, а не урезанный остаток от предыдущей попытки.
 * Суммарный retry-бюджет по умолчанию (maxRetries=2, baseDelayMs=300) —
 * максимум ~1.5с сверх timeoutMs, что укладывается в ~1.5x даже для самых
 * коротких таймаутов в waterfall-цепочке (12с у openai/gpt-4o-mini).
 */
function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * Хосты НАШЕГО релея — единственные, кому положен секрет.
 *
 * Находка аудита 08.09. Здесь стоял ЗАПРЕТИТЕЛЬНЫЙ список из двух имён
 * («всем, кроме openrouter.ai и api.anthropic.com»), а комментарий выше
 * обещал обратное: «на прямой адрес апстрима секрет не уходит». Обещание и
 * код разошлись, и разошлись в дорогую сторону: `fetchModelIds` ходит этой
 * же дорогой на ПРЯМЫЕ адреса чужих провайдеров —
 * `https://api.x.ai/v1/models`, `https://api.deepseek.com/models`,
 * `${MOONSHOT_BASE}/models`, `${base}/models` резолвера, — и каждому из них
 * уходил заголовок `X-Relay-Secret`. Секрет, которым релей отличает нас от
 * посторонних, лежал в логах четырёх посторонних.
 *
 * Запретительный список тут не чинится добавлением имён: чужих хостов
 * столько, сколько провайдеров, и следующий появится без нас. Своих же
 * ровно столько, сколько мы НАСТРОИЛИ, и они известны поимённо — отсюда
 * разрешительный список, выведенный из конфигурации: хост попадает в него
 * только если база задана переменной и увела нас с домашнего адреса
 * провайдера. Ничего не настроено — множество пусто, секрет не уходит
 * никому.
 */
const RELAY_HOSTS: ReadonlySet<string> = new Set(
  ([
    [OPENROUTER_BASE, OPENROUTER_DIRECT],
    [ANTHROPIC_BASE, 'https://api.anthropic.com'],
  ] as const)
    .filter(([base, direct]) => base !== direct)
    .map(([base]) => hostOf(base))
    .filter((h): h is string => h !== null && h !== 'openrouter.ai' && h !== 'api.anthropic.com'),
);

/**
 * Секрет релея — ТОЛЬКО когда мы действительно идём через релей.
 *
 * Зачем отдельная точка прохода, а не заголовок по месту вызова: обращений
 * к OPENROUTER_BASE и ANTHROPIC_BASE в этом файле два с лишним десятка, и
 * добавлять секрет в каждое руками — это гарантированно забыть одно.
 *
 * Разрыв нашёлся 23.08 при подготовке VPS-релея: X-Relay-Secret слал
 * только github-fetch, а вызовы OpenRouter и Anthropic — нет. У воркера
 * проверка секрета опциональна, поэтому промаха не было видно; на VPS она
 * обязательна (публичный адрес находят сканами), и релей ответил бы своим
 * 403 `{"error":"forbidden"}` — до отвращения похожим на чужой 403
 * `{"success":false,"error":"Access denied by security policy."}`, из-за
 * которого весь этот разбор и затевался.
 *
 * Кому НЕ уходит — решает RELAY_HOSTS выше. Прежняя редакция этой строки
 * обещала «на прямой адрес апстрима секрет не уходит», а код обещание не
 * выполнял: список был запретительный из двух имён.
 */
function withRelaySecret(url: string, headers: HeadersInit | undefined): HeadersInit | undefined {
  const host = hostOf(url);
  if (host === null || !RELAY_HOSTS.has(host)) return headers;

  const secret = process.env.RELAY_SECRET?.trim();
  if (!secret) return headers;

  const h = new Headers(headers);
  h.set('X-Relay-Secret', secret);
  return h;
}

/** fetch к релею: тот же вызов плюс секрет, если идём не напрямую. */
function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: withRelaySecret(url, init.headers) });
}

/** fetchWithRetry к релею: то же самое поверх повторов. */
function relayFetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  opts: { timeoutMs: number; maxRetries?: number; baseDelayMs?: number; label?: string },
): Promise<Response> {
  return fetchWithRetry(url, { ...init, headers: withRelaySecret(url, init.headers) }, opts);
}

export async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  opts: { timeoutMs: number; maxRetries?: number; baseDelayMs?: number; label?: string },
): Promise<Response> {
  const { timeoutMs, maxRetries = 2, baseDelayMs = 300, label } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const retryable = RETRYABLE_STATUS.has(res.status);
      if (res.ok || attempt === maxRetries || !retryable) {
        // Тело не трогаем — его читает вызывающий. Статуса достаточно.
        if (!res.ok) noteProviderFailure(label, `HTTP ${res.status}`);
        return res;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === maxRetries || !isRetryableNetworkError(err)) {
        noteProviderFailure(label, err instanceof Error ? err.message : 'сетевая ошибка');
        throw err;
      }
      lastErr = err;
    }
    const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
    console.warn(`[ai:retry] ${label ?? url} retrying after ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
    await sleep(delay);
  }
  // Недостижимо (цикл всегда return/throw на attempt === maxRetries), но TS требует возврат.
  throw lastErr instanceof Error ? lastErr : new Error('fetchWithRetry: retries exhausted');
}

// Xiaomi MiMo: прямой api.xiaomimimo.com отключён 04.07.2026 (эндпоинт не
// отвечал), а функция callMiMo пережила отключение и три недели значилась
// «оставленной на будущее» — при том что заявленный путь возврата проходит
// через OpenRouter (модель-id в OR_MODELS), а не через прямой вызов. Удалена
// 22.08.2026: обещание в комментарии не есть механизм.

// ── OpenRouter ─────────────────────────────────────────────────
// Пробует несколько моделей по очереди — защита от rate limit одной модели.
// Порядок: сначала быстрые и надёжные, timeout снижен до 12s
const OR_MODELS = [
  { id: 'anthropic/claude-fable-5',                     timeout: 20_000 }, // flagship
  { id: 'anthropic/claude-opus-5',                      timeout: 20_000 }, // flagship fallback (safety blocks)
  { id: 'anthropic/claude-haiku-4-5-20251001',          timeout: 15_000 }, // fast fallback
  { id: 'anthropic/claude-haiku-4-5',                   timeout: 15_000 }, // alias fallback
  { id: 'openai/gpt-4o-mini',                           timeout: 12_000 }, // non-anthropic backup
  { id: 'meta-llama/llama-3.3-70b-instruct',            timeout: 12_000 }, // free fallback
];

// If OpenRouter returns auth errors (401), avoid repeated slow failures.
// Only 401 triggers cooldown (bad key). 403 may be model-specific (geo-block, access).
const OPENROUTER_AUTH_COOLDOWN_MS = 5 * 60 * 1000;
let openRouterDisabledUntil = 0;

function isOpenRouterTemporarilyDisabled(): boolean {
  return Date.now() < openRouterDisabledUntil;
}

function markOpenRouterAuthFailure(): void {
  openRouterDisabledUntil = Date.now() + OPENROUTER_AUTH_COOLDOWN_MS;
}

function clearOpenRouterFailure(): void {
  openRouterDisabledUntil = 0;
}

/**
 * Диагностика ключа OpenRouter для health-эндпоинта: GET /api/v1/key —
 * бесплатный запрос (не тратит токены), различает 401 (ключ неверный),
 * лимиты/кредиты (в body) и сетевую недоступность с хостинга (timeout).
 * callOpenrouter такие детали глотает (catch → null) — по нему причину
 * падения провайдера снаружи не увидеть.
 */
export async function probeOpenRouterKeyStatus(): Promise<{
  key_source: 'OR_API_KEY' | 'OPENROUTER_API_KEY' | null;
  both_env_set: boolean;
  /** Куда реально ушёл запрос: через релей или напрямую в openrouter.ai. */
  route: 'relay' | 'direct';
  /** Хост назначения (без пути и без ключей) — чтобы отличить один релей от другого. */
  route_host: string;
  http_status: number | null;
  detail: string;
  /**
   * Тот же запрос НАПРЯМУЮ в openrouter.ai, минуя релей. Заполняется только
   * когда база релейная — иначе это был бы дубль основного измерения (null).
   *
   * Зачем. 22.08 прод через релей получал 403 с телом
   * `{ "success": false, "error": "Access denied by security policy." }`, тогда
   * как раннер тем же путём получал настоящий ответ OpenRouter
   * (`{"error":{"message":"No cookie auth credentials found","code":401}}`).
   * Формат чужой, значит отвечает не OpenRouter — а кто, по одному коду не
   * узнать. Сравнение с прямым путём разделяет два разных диагноза:
   * совпало — режет край сети по нашему адресу, и релей его не прячет
   * (лечится сменой площадки релея); не совпало — режет что-то на выходе
   * из Timeweb именно к релею (лечится в другом месте).
   */
  direct_status: number | null;
  direct_detail: string | null;
  /**
   * Форма ключа без его содержимого: длина, ожидаемое начало, пробелы.
   * 22.08 OpenRouter отвечал «Missing Authentication header» при непустой
   * переменной — а это сходится ровно тогда, когда значение непусто как
   * строка и пусто как ключ. Три этих факта разделяют «вставили не то»,
   * «вставили с переводом строки» и «ключ настоящий, отказывает провайдер».
   */
  key_shape: ReturnType<typeof describeOpenRouterKey>;
}> {
  const key_source = getOpenRouterKeySource();
  const both_env_set = !!process.env.OR_API_KEY && !!process.env.OPENROUTER_API_KEY;
  // Голый статус без адресата не диагноз: 403 «напрямую» — это гео-блок и
  // лечится релеем, а 403 «через релей» — это уже сам релей (не поднят, не
  // тот путь, закрыт по РФ) и лечится совсем иначе. Раньше диагностика
  // печатала только код, и по нему нельзя было отличить одно от другого —
  // ровно то «место, где нельзя сказать „не знаю“», о котором правило §4.0.
  const route: 'relay' | 'direct' =
    OPENROUTER_BASE === 'https://openrouter.ai/api/v1' ? 'direct' : 'relay';
  let route_host = 'openrouter.ai';
  try { route_host = new URL(OPENROUTER_BASE).host; } catch { /* оставляем дефолт */ }

  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    return {
      key_source, both_env_set, route, route_host,
      http_status: null, detail: 'ключ не задан',
      direct_status: null, direct_detail: null,
      key_shape: describeOpenRouterKey(),
    };
  }

  /** Один и тот же запрос по заданному адресу. Ключ уходит только на openrouter.ai или на наш релей. */
  const ask = async (base: string): Promise<{ status: number | null; detail: string }> => {
    try {
      // relayFetch, а не голый: base здесь бывает и релеем, и прямым
      // адресом, а секрет нужен только первому. Точка прохода решает это
      // сама — по хосту, а не по флагу вызывающего.
      const res = await relayFetch(`${base}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      return { status: res.status, detail: (await res.text()).slice(0, 300) };
    } catch (e) {
      // Третий исход: сеть не ответила — это не «доступ закрыт» и не «всё хорошо».
      return { status: null, detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}` };
    }
  };

  const main = await ask(OPENROUTER_BASE);

  // Прямой путь меряем ТОЛЬКО когда основной релейный: иначе это тот же запрос дважды.
  const direct = route === 'relay' ? await ask(OPENROUTER_DIRECT) : null;

  return {
    key_source,
    both_env_set,
    route,
    route_host,
    http_status: main.status,
    detail: main.detail,
    direct_status: direct ? direct.status : null,
    direct_detail: direct ? direct.detail : null,
    key_shape: describeOpenRouterKey(),
  };
}

export async function callOpenrouter(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;
  if (isOpenRouterTemporarilyDisabled()) return null;

  const payload = messages.map(({ role, content }) => ({ role, content }));

  for (const { id, timeout } of OR_MODELS) {
    try {
      const res = await relayFetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...openRouterAttribution(),
        },
        body: JSON.stringify({
          model: id,
          temperature: 0.4,
          max_tokens: 800,
          messages: payload,
        }),
      }, { timeoutMs: timeout, label: `openrouter:${id}` });

      if (!res.ok) {
        if (res.status === 401) {
          markOpenRouterAuthFailure();
          return null;
        }
        continue; // next model
      }

      clearOpenRouterFailure();
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: ProviderUsage;
      };
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      if (text?.trim()) {
        logLLMUsage(answeredModel(id, data), data.usage);
        return text;
      }
      // No valid content — try next model
    } catch { continue; }
  }

  return null;
}

// ── OpenRouter: specific model ────────────────────────────────
// Calls a single specific model via OpenRouter. Used for per-agent model assignment.

export interface OpenRouterModelOptions {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /** JSON Schema for structured outputs (supported by GPT-4.1, Gemini 2.5, etc.) */
  jsonSchema?: { name: string; strict?: boolean; schema: Record<string, unknown> };
  /**
   * Зовётся, когда модель НЕ ответила, и называет причину.
   *
   * Функция отдаёт `null` на четыре разных события: провайдер отказал по HTTP,
   * ответ пришёл без текста, запрос не дошёл, ключа нет. Наружу все четыре
   * выглядели одинаково, и отчёт судьи писал про первую ступень «ключ есть,
   * ответа нет» — фразу, из которой нельзя понять ни 401, ни 402, ни 403.
   * Рядом ступень Anthropic честно печатала тело ошибки («credit balance is
   * too low»), и разница была видна невооружённым глазом.
   *
   * Здесь не выдумывается новое поведение: возврат по-прежнему `null`, просто
   * причина больше не пропадает. Тело обрезается — в нём бывает эхо запроса.
   */
  onRefusal?: (info: { kind: 'http' | 'empty' | 'network' | 'no_key'; status: number | null; detail: string }) => void;
}

export async function callOpenRouterModel(
  messages: ChatMessage[],
  modelId: string,
  timeoutOrOpts: number | OpenRouterModelOptions = 15_000,
): Promise<{ text: string; model_used: string } | null> {
  const opts: OpenRouterModelOptions = typeof timeoutOrOpts === 'number'
    ? { timeoutMs: timeoutOrOpts }
    : timeoutOrOpts;
  const { timeoutMs = 15_000, maxTokens = 800, temperature = 0.4, jsonMode = false, jsonSchema, onRefusal } = opts;

  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    onRefusal?.({ kind: 'no_key', status: null, detail: 'ключ OpenRouter не задан' });
    return null;
  }
  if (isOpenRouterTemporarilyDisabled()) {
    onRefusal?.({ kind: 'no_key', status: null, detail: 'провайдер временно отключён после отказа авторизации' });
    return null;
  }

  const payload = messages.map(({ role, content }) => ({ role, content }));

  try {
    const body: Record<string, unknown> = {
      model: modelId,
      temperature,
      max_tokens: maxTokens,
      messages: payload,
    };
    if (jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: jsonSchema };
    } else if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await relayFetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openRouterAttribution(),
      },
      body: JSON.stringify(body),
    }, { timeoutMs, label: `openrouter-model:${modelId}` });

    if (!res.ok) {
      if (res.status === 401) {
        markOpenRouterAuthFailure();
      }
      if (onRefusal) {
        const body = await res.text().catch(() => '');
        onRefusal({ kind: 'http', status: res.status, detail: body.slice(0, 200) || 'тело ответа пустое' });
      }
      return null;
    }

    clearOpenRouterFailure();
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text = data?.choices?.[0]?.message?.content;
    // Расход пишется ДО проверки текста: пустой ответ тоже оплачен, и счёт,
    // который учитывает только удачные вызовы, занижает трату ровно там, где
    // модель капризничает. Тринадцать ступеней из четырнадцати писали usage
    // всегда — не писала ровно эта, самая дорогая: через неё идёт флагман.
    // Отсюда и слепое пятно, названное в шапке lib/ai/model-cost.ts как то,
    // что мешает перейти от оценки к замеру.
    logLLMUsage(answeredModel(modelId, data), data?.usage);
    if (!text?.trim()) {
      onRefusal?.({ kind: 'empty', status: res.status, detail: 'ответ 200, но текста в нём нет' });
      return null;
    }
    return { text: text.trim(), model_used: modelId };
  } catch (e) {
    onRefusal?.({
      kind: 'network',
      status: null,
      detail: `сеть/timeout: ${e instanceof Error ? e.message.slice(0, 150) : 'ошибка'}`,
    });
    return null;
  }
}

// ── OpenRouter: Function calling (tools) ──────────────────────

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolsCallResult {
  content: string | null;
  tool_calls: ToolCall[] | null;
  /**
   * Кто ответил. Ставится водопадом инструментов, а не самими вызовами:
   * знание «чей это ответ» терялось ровно здесь. `undefined` — вызов пришёл
   * не через водопад (прямой callDeepSeekWithTools в пробе), и это честное
   * «не записано», а не «никто».
   */
  provider?: string;
}

type ToolMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export async function callOpenRouterWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  modelId = 'openai/gpt-4o-mini',
  timeoutMs = 20_000,
): Promise<ToolsCallResult | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) { recordAiLegFailure('openrouter:tools', 'no_key'); return null; }
  if (isOpenRouterTemporarilyDisabled()) { recordAiLegFailure('openrouter:tools', 'ступень отключена после прошлого отказа'); return null; }

  try {
    const res = await relayFetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openRouterAttribution(),
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.3,
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: 'auto',
      }),
    }, { timeoutMs, label: `openrouter-tools:${modelId}` });

    if (!res.ok) {
      if (res.status === 401) markOpenRouterAuthFailure();
      recordAiLegFailure('openrouter:tools', httpFailureReason(res.status, await res.text().catch(() => '')));
      return null;
    }

    clearOpenRouterFailure();
    const data = await res.json() as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };

    const msg = data?.choices?.[0]?.message;
    if (!msg) { recordAiLegFailure('openrouter:tools', `empty (${modelId}): ${describeEmptyCompletion(data)}`); return null; }

    return {
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
    };
  } catch (e) {
    recordAiLegFailure('openrouter:tools', errorFailureReason(e));
    return null;
  }
}

// DeepSeek tool-calling (OpenAI-совместимый function-calling). Используется как
// фоллбэк tools-цикла, когда OpenRouter недоступен — например, регион-блокирует
// IP хостинга (403 "Access denied by security policy"): замена ключа не помогает,
// а DeepSeek с российского хостинга доступен.
export async function callDeepSeekWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  modelId?: string,
  timeoutMs = 25_000,
): Promise<ToolsCallResult | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) { recordAiLegFailure('deepseek:tools', 'no_key'); return null; }

  try {
    const model = modelId ?? await resolveDeepSeekModel();
    const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: 'auto',
        ...deepseekThinking(),
      }),
    }, { timeoutMs, label: `deepseek-tools:${model}` });

    if (!res.ok) {
      recordAiLegFailure('deepseek:tools', httpFailureReason(res.status, await res.text().catch(() => '')));
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };
    const msg = data?.choices?.[0]?.message;
    if (!msg) { recordAiLegFailure('deepseek:tools', `empty (${model}): ${describeEmptyCompletion(data)}`); return null; }

    return {
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
    };
  } catch (e) {
    recordAiLegFailure('deepseek:tools', errorFailureReason(e));
    return null;
  }
}

// xAI tool-calling (callXaiWithTools) — вторая живая нога этого цикла, но
// живёт она ниже, вместе с остальным xAI: ей нужен resolveXaiModel, а
// соседние пробы режут этот файл по границам функций и на имени-приставке
// «callXai...» ловят не ту.
// Qwen tool-calling (OpenAI-совместимый, Alibaba DashScope). Снят 08.09
// («qwen не используем»: ключ отвергнут в обоих регионах, ступень отвечала
// отказом на каждое сообщение) и ВОЗВРАЩЁН 24.09 решением владельца «верни
// Qwen в текстовые пути» — после пополнения баланса. Возврат подтверждён
// замером, а не ожиданием: проба 571 с прода, qwen-vl-max на том же ключе
// ответил за 1,1 с.
//
// Модель СОЗНАТЕЛЬНО не резолвится через /v1/models, в отличие от callQwen:
// это живой путь Кузьмича, где ответа ждёт человек — в поле, иногда на плохой
// связи. Резолв добавил бы сетевой round-trip на холодном кэше, а сильная
// модель ещё и отвечает дольше. Качество здесь вытягивают инструменты и
// заземление в БД, а не тир модели. Нужен другой тир — QWEN_MODEL.
//
// В прежней редакции каждый отказ глушился (`if (!res.ok) return null`,
// `catch { return null }`), и «нет ключа», квота и таймаут были снаружи
// неразличимы — именно поэтому отвергнутый ключ неделями стоял первым в
// очереди. Теперь у каждого выхода в null названа причина.
export async function callQwenWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  timeoutMs = 25_000,
): Promise<ToolsCallResult | null> {
  const { apiKey, base, model: configured } = getQwenConfig();
  if (!apiKey) { recordAiLegFailure('qwen:tools', 'no_key'); return null; }

  // Квота кончается по моделям (25.09, lib/ai/qwen-free-quota): исчерпанная
  // модель помечается, и тот же вызов идёт на её снимок. Три попытки — потолок
  // задержки для человека в поле; дальше ответит следующая ступень.
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = await nextQwenToolsModel(configured);
    if (!model) break;
    try {
      const res = await fetchWithRetry(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 1000,
          messages,
          tools,
          tool_choice: 'auto',
        }),
      }, { timeoutMs, label: `qwen-tools:${model}` });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (isFreeQuotaExhausted(res.status, body)) { markFreeQuotaExhausted(model); continue; }
        recordAiLegFailure('qwen:tools', httpFailureReason(res.status, body));
        return null;
      }

      const data = await res.json() as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: ToolCall[] };
        }>;
      };
      const msg = data?.choices?.[0]?.message;
      if (!msg) { recordAiLegFailure('qwen:tools', `empty (${model}): ${describeEmptyCompletion(data)}`); return null; }

      return {
        content: msg.content ?? null,
        tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
      };
    } catch (e) {
      recordAiLegFailure('qwen:tools', errorFailureReason(e));
      return null;
    }
  }
  recordAiLegFailure('qwen:tools', `free_quota_exhausted: ${exhaustedModels().join(', ')}`);
  return null;
}

/** Первый непустой результат из списка попыток; поздние не зовём после успеха. */
/**
 * Первый непустой ответ по очереди.
 *
 * Обёртка над помеченной версией: имя не передано — в результате его не
 * будет, и это честное «не записано». Свой цикл здесь разошёлся бы с тем,
 * что ниже, — та же болезнь, что две копии создания брони (08.09).
 */
export async function firstNonNullTool(
  attempts: Array<() => Promise<ToolsCallResult | null>>,
): Promise<ToolsCallResult | null> {
  const r = await firstNonNullToolLabelled(attempts.map(run => ({ provider: '', run })));
  if (!r) return null;
  const { provider: _unnamed, ...rest } = r;
  return rest;
}

/** То же по очереди, но помнит имя ответившего. */
export async function firstNonNullToolLabelled(
  attempts: Array<{ provider: string; run: () => Promise<ToolsCallResult | null> }>,
): Promise<ToolsCallResult | null> {
  for (const { provider, run } of attempts) {
    const r = await run();
    if (r) return { ...r, provider };
  }
  return null;
}

// Водопад инструментов: DeepSeek (первичный — доступен из РФ) → xAI (вторая
// живая нога) → OpenRouter (последний шанс, авто-восстановление если
// разблокируют). Раньше tools-цикл Кузьмича висел только на OpenRouter — при
// регион-блоке инструменты отваливались, чат жил без tools.
//
// xAI внесён 19.09 и стоит ПЕРЕД OpenRouter намеренно. Ног было две только на
// бумаге: OpenRouter гео-блокируется с прода неделями, и в ночь, когда
// DeepSeek ушёл в таймаут, цикл остался без ответа вовсе. Порядок здесь — не
// вкус, а тот же урок, что с Qwen выше: ступени идут ПОСЛЕДОВАТЕЛЬНО, и
// заведомо отказывающая впереди живой — это секунды ожидания человека в поле,
// купленные ни за что. OpenRouter из очереди не убран: гео-блок снимут — он
// вернётся сам, а гадать об этом не нужно.
//
// Qwen (24.09, решение владельца «верни Qwen в текстовые пути») стоит ВТОРЫМ,
// между DeepSeek и xAI. Не первым: DeepSeek первичный с 08.09 и отвечает за
// доли секунды, менять первичного на живом пути — отдельное решение по замеру
// задержки, а не следствие возврата. И не после xAI: у того лёгкая модель
// отвечает 13 с, сильная — 43 (замер 04.09), а Qwen доступен из РФ напрямую —
// значит при отказе DeepSeek человек в поле получит ответ быстрее.
//
// Урок 08.09 остаётся в силе: нога, которая отвечает отказом всегда, впереди
// живой — это секунды ожидания, купленные ни за что. Поэтому отказ Qwen теперь
// пишется с причиной (failure-trace), а health будит, когда ключ не принят.
export async function callToolsWaterfall(
  messages: ToolMsg[],
  tools: ToolDefinition[],
): Promise<ToolsCallResult | null> {
  return firstNonNullToolLabelled([
    { provider: 'deepseek',   run: () => callDeepSeekWithTools(messages, tools) },   // первичный: доступен из РФ
    { provider: 'qwen',       run: () => callQwenWithTools(messages, tools) },       // возвращён 24.09: из РФ напрямую, быстрее xAI
    { provider: 'xai',        run: () => callXaiWithTools(messages, tools) },        // вторая ЖИВАЯ нога (19.09)
    { provider: 'openrouter', run: () => callOpenRouterWithTools(messages, tools) }, // последний шанс (авто-восстановление если разблокируют)
  ]);
}

// Call AI with a preferred model. Falls back to full waterfall if preferred model fails.
export async function callAIWithModel(
  messages: ChatMessage[],
  preferredModel?: string | null,
  opts?: OpenRouterModelOptions,
): Promise<{ text: string; model_used: string }> {
  if (preferredModel) {
    const result = await callOpenRouterModel(messages, preferredModel, opts ?? 15_000);
    if (result) return result;
  }
  const text = await callAIWaterfall(messages);
  return { text, model_used: 'waterfall-fallback' };
}

// ── Minimax ────────────────────────────────────────────────────
export async function callMinimax(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return null;

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const payload = turns.map(({ role, content }) => ({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    }));

    const res = await fetch('https://api.minimaxi.chat/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'MiniMax-Text-01',
        temperature: 0.4,
        max_tokens: 800,
        ...(systemMsg ? { system_prompt: systemMsg.content } : {}),
        messages: payload,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return null;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    return null;
  }
}

// ── xAI (Grok) ────────────────────────────────────────────────
/**
 * Модель xAI — из /v1/models, без привязки к id (CLAUDE.md §8).
 *
 * До 04.09 во всех трёх местах стоял хардкод `grok-4`, а живой каталог
 * провайдера к этому дню состоял из grok-4.6 / 4.5 / 4.3 / grok-build-0.1
 * (справка владельца). Ровно та же болезнь, что убила прямой путь DeepSeek
 * 26.07 и пробу Gemini 04.09: провайдер сменил линейку, а мы продолжали
 * звать снятое имя. Override — env XAI_MODEL.
 */
const XAI_MODELS_TTL_MS = 6 * 60 * 60 * 1000;
const xaiModelCache = new Map<string, { id: string; at: number }>();
let xaiListProblem: string | null = null;

/** Почему каталог xAI не добыт в последний раз; null — добыт. */
export function xaiResolveProblem(): string | null { return xaiListProblem; }

/**
 * Модель xAI под НАЗНАЧЕНИЕ, потому что разница в скорости здесь в три раза.
 *
 * Замер 04.09 (ai-debug run 10, с прода): grok-4.6 отвечает за 43 с,
 * grok-build-0.1 — за 13 с. Для человека в поле, ждущего Кузьмича, сорок три
 * секунды это не «медленно», а «не ответил»; для ночного крона, пишущего
 * текст, — приемлемая цена за сильную модель. Поэтому назначения два, и они
 * не смешиваются: 'fast' для живого пути, 'strong' для генерации контента.
 *
 * Лёгкая выбирается по имени (mini/fast/flash/lite/build), а не по позиции в
 * списке: порядок каталога провайдера — не обещание. Не нашлось такой —
 * берётся самая слабая пригодная, и это честнее, чем подсунуть флагман туда,
 * где ждут быстро.
 */
export async function resolveXaiModel(purpose: 'strong' | 'fast' = 'strong'): Promise<string | null> {
  const override = (purpose === 'fast' ? process.env.XAI_FAST_MODEL : process.env.XAI_MODEL)?.trim();
  if (override) return override;
  const cached = xaiModelCache.get(purpose);
  if (cached && Date.now() - cached.at < XAI_MODELS_TTL_MS) return cached.id;

  const key = getXaiKey();
  if (!key) { xaiListProblem = 'ключа нет'; return null; }
  const ids = await fetchModelIds('https://api.x.ai/v1/models', key);
  if (ids.length === 0) { xaiListProblem = 'каталог пуст или недоступен'; return null; }
  const eligible = classifyModels(ids).filter(m => m.eligible).map(m => m.id);
  const picked = purpose === 'fast'
    ? (eligible.find(id => /mini|fast|flash|lite|build/i.test(id)) ?? eligible[eligible.length - 1] ?? null)
    : pickBestModel(ids);
  if (!picked) { xaiListProblem = `в каталоге ${ids.length} моделей, ни одной пригодной`; return null; }
  xaiListProblem = null;
  xaiModelCache.set(purpose, { id: picked, at: Date.now() });
  return picked;
}

/**
 * Достижим ли api.x.ai С ЭТОГО адреса — БЕЗ ключа и намеренно.
 *
 * Разбор 04.09 встал на том, что xAI отвечает `{"code":"invalid-argument",
 * "error":"Incorrect API key provided"}`, и у этого ответа два несовместимых
 * кандидата: гео-отказ по адресу запроса (слова владельца) и вопрос к самому
 * ключу либо счёту (кредиты в консоли x.ai отдельны от подписки). Спорить об
 * этом бесполезно, различает их проба.
 *
 * Запрос идёт БЕЗ Authorization. Тогда ответ говорит о ДОРОГЕ, а не о ключе:
 * 401/403 с телом самого xAI значит «дошли, дело в авторизации»; ответ края
 * (Cloudflare и подобные) либо сетевой отказ значит «не дошли вовсе». Ключ в
 * пробе не участвует, поэтому она ничего о нём не утверждает и утечь ему
 * некуда.
 */
export async function probeXaiReachable(): Promise<{ reached: boolean | null; detail: string }> {
  try {
    const res = await fetch('https://api.x.ai/v1/models', {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    // Своё тело xAI — JSON с полем code/error; край отдаёт html или чужой JSON.
    const ownShape = /"(code|error)"\s*:/.test(body);
    if (ownShape) return { reached: true, detail: `HTTP ${res.status}, тело xAI: ${body}` };
    return { reached: false, detail: `HTTP ${res.status}, тело не похоже на ответ xAI: ${body}` };
  } catch (e) {
    return { reached: null, detail: `сеть не дала ответа: ${errorFailureReason(e)}` };
  }
}

/**
 * Ответ оборван по потолку токенов (26.09).
 *
 * Владелец прислал AI-дайджест 25.09: единственный материал, и тот обрывается
 * на «получает собственную перси». Провайдер вернул HTTP 200 с
 * `finish_reason: "length"`, путь генерации текста взял непустой `content`
 * как готовый ответ, а срезатель хвоста (`lib/text/digest-polish`) обрыв не
 * узнал: он судит по соседним строкам, а соседей у обрывка не было.
 *
 * Обрыв — не ответ, а отказ ступени с причиной (§4.0): текст, который
 * прочитают люди, либо целый, либо его нет. Решение принимается по полю
 * провайдера, а не по виду текста — угадывать обрыв по последней букве
 * значит ошибаться в обе стороны.
 */
export function completionTruncated(data: unknown): boolean {
  const reason = (data as { choices?: Array<{ finish_reason?: string | null }> } | null)?.choices?.[0]?.finish_reason;
  return reason === 'length';
}

export async function callXai(
  messages: ChatMessage[],
  opts: { purpose?: 'strong' | 'fast'; timeoutMs?: number; maxTokens?: number; rejectTruncated?: boolean } = {},
): Promise<string | null> {
  const { purpose = 'fast', timeoutMs = purpose === 'fast' ? 30_000 : 90_000, maxTokens = 800, rejectTruncated = false } = opts;
  const apiKey = getXaiKey();
  if (!apiKey) { recordAiLegFailure('xai', 'no_key'); return null; }
  const model = await resolveXaiModel(purpose);
  if (!model) { recordAiLegFailure('xai', `модель не разрешена: ${xaiResolveProblem() ?? 'каталог недоступен'}`); return null; }

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: maxTokens,
        messages: payload,
      }),
      // Бюджет от назначения: замер 04.09 — grok-4.6 43 с, grok-build-0.1 13 с.
      // Прежние 20 с обрезали ОБЕ модели на флагмане и делали живого
      // провайдера мёртвым.
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Отказ назывался молчанием: тело ошибки читалось в переменную и
    // выбрасывалось, наверх шёл голый null. Тот же дефект, из-за которого
    // «Incorrect API key» полдня считали то гео-блоком, то мёртвым ключом.
    if (!res.ok) {
      recordAiLegFailure('xai', httpFailureReason(res.status, await res.text().catch(() => '')));
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }> };
    const text = data?.choices?.[0]?.message?.content;
    // Только по просьбе вызывающего: путь текста для людей (callAIQuality)
    // обрывок не берёт, а живой чат решает за себя отдельно.
    if (text?.trim() && rejectTruncated && completionTruncated(data)) {
      recordAiLegFailure('xai', `truncated (${model}): finish_reason=length, ответ ${text.length} знаков при maxTokens=${maxTokens}`);
      return null;
    }
    if (text?.trim()) return text;
    recordAiLegFailure('xai', `empty (${model}): ${describeEmptyCompletion(data)}`);
    return null;
  } catch (e) { recordAiLegFailure('xai', errorFailureReason(e)); return null; }
}

/**
 * xAI tool-calling — ВТОРАЯ живая нога цикла инструментов (19.09).
 *
 * Повод. В ночь на 19.09 DeepSeek перестал отвечать с прода: 18.09 в 22:37
 * UTC — HTTP 200 за 3,4 с, 19.09 в 01:14 — сетевой таймаут на 35,7 с. Ключ на
 * месте, ответа нет. И выяснилось, что у tools-цикла Кузьмича ног было две
 * только на бумаге: вторая, OpenRouter, гео-блокируется с прода неделями и
 * отвечает отказом ещё до запроса. То есть цикл инструментов стоял на ОДНОЙ
 * ноге, и в ту ночь она подломилась.
 *
 * Без инструментов Кузьмич не немеет — вызывающий уходит в водопад без tools
 * с предварительным поиском, — но отвечает он тогда из общих соображений там,
 * где должен был спросить занятость, погоду или профиль безопасности точки.
 * Для платформы, чья цель безопасность туриста, это худший вид отказа:
 * выглядит как ответ.
 *
 * Почему xAI. Из достижимых с прода провайдеров с function-calling он
 * единственный, кого не надо чинить: Qwen снят с текстовых путей 08.09 (вернулся 24.09),
 * Anthropic отвечает «credit balance is too low», Gemini гео-блокируется,
 * Timeweb-шлюз игнорирует параметр `model` и каталога не отдаёт вовсе.
 *
 * Сначала 'fast', и это не экономия: замер 04.09 — grok-4.6 отвечает 43 с,
 * grok-build-0.1 — 13 с. Человек в поле на плохой связи сорок три секунды не
 * ждёт, для него это «не ответил». Модель резолвится из `/v1/models` (§8), id
 * здесь не хардкодится.
 *
 * ПОЧЕМУ ДВЕ ПОПЫТКИ. Поддерживает ли лёгкая модель каталога function-calling,
 * отсюда не проверить — каталог отдаёт только имена, а ключа у раннера нет.
 * Ставить ступень на непроверенной посылке значит завести «объявленный исход
 * без источника» (§4): нога есть, а ответа от неё не будет никогда, и узнать
 * об этом будет неоткуда. Поэтому отказ HTTP на лёгкой модели — не приговор
 * провайдеру: пробуем сильную, один раз. Цена платится только там, где
 * DeepSeek уже не ответил, то есть в уже испорченном случае; в норме до этой
 * ветки не доходит вовсе. Обе причины остаются в следе — какая именно модель
 * отказала, видно на /hub/admin/health.
 */
export async function callXaiWithTools(
  messages: ToolMsg[],
  tools: ToolDefinition[],
  timeoutMs = 30_000,
): Promise<ToolsCallResult | null> {
  const apiKey = getXaiKey();
  if (!apiKey) { recordAiLegFailure('xai:tools', 'no_key'); return null; }

  let httpRefused = false;
  for (const purpose of ['fast', 'strong'] as const) {
    // Сильная идёт только после ОТКАЗА СЕРВЕРА на лёгкой. Таймаут, пустой
    // ответ и «модель не разрешена» второй попытки не заслуживают: первое —
    // уже потраченное ожидание человека, остальные о поддержке инструментов
    // ничего не говорят.
    if (purpose === 'strong' && !httpRefused) break;

    const model = await resolveXaiModel(purpose);
    if (!model) {
      recordAiLegFailure('xai:tools', `модель не разрешена (${purpose}): ${xaiResolveProblem() ?? 'каталог недоступен'}`);
      return null;
    }

    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 1000,
          messages,
          tools,
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(purpose === 'fast' ? timeoutMs : 45_000),
      });

      if (!res.ok) {
        recordAiLegFailure('xai:tools', `${purpose}/${model}: ${httpFailureReason(res.status, await res.text().catch(() => ''))}`);
        httpRefused = true;
        continue;
      }

      const data = await res.json() as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: ToolCall[] };
        }>;
      };
      const msg = data?.choices?.[0]?.message;
      if (!msg) { recordAiLegFailure('xai:tools', `empty (${model}): ${describeEmptyCompletion(data)}`); return null; }

      return {
        content: msg.content ?? null,
        tool_calls: msg.tool_calls?.length ? msg.tool_calls : null,
      };
    } catch (e) {
      recordAiLegFailure('xai:tools', `${purpose}/${model}: ${errorFailureReason(e)}`);
      return null;
    }
  }
  return null;
}

// ── Anthropic Claude (direct API) ───────────────────────────

// Marker to split a system message into cached prefix + uncached dynamic suffix.
// Callers append "\n\n<<<CACHE_BREAK>>>\n\n" between the static (cacheable) part
// and the dynamic (per-request) part. Without the marker, the whole system
// message is cached as a single block (existing behavior preserved).
export const CACHE_BREAK_MARKER = '<<<CACHE_BREAK>>>';

function buildSystemBlocks(systemContent: string): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  const sep = `\n\n${CACHE_BREAK_MARKER}\n\n`;
  const idx = systemContent.indexOf(sep);
  if (idx < 0) {
    return [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }];
  }
  const cached = systemContent.slice(0, idx);
  const dynamic = systemContent.slice(idx + sep.length);
  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
  if (cached) blocks.push({ type: 'text', text: cached, cache_control: { type: 'ephemeral' } });
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  return blocks;
}

export async function callAnthropic(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getAnthropicKey();
  if (!apiKey) return null;

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const firstUserIdx = turns.findIndex(m => m.role === 'user');
    const clean = firstUserIdx >= 0 ? turns.slice(firstUserIdx) : turns;
    const window = clean.slice(-6);
    const startIdx = window.findIndex(m => m.role === 'user');
    const trimmed = startIdx > 0 ? window.slice(startIdx) : window;

    if (!trimmed.length) return null;

    const anthropicMessages = trimmed.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const res = await relayFetchWithRetry(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
        max_tokens: 800,
        temperature: 0.4,
        ...(systemMsg ? { system: buildSystemBlocks(systemMsg.content) } : {}),
        messages: anthropicMessages,
      }),
    }, { timeoutMs: 20_000, label: 'anthropic' });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // Fable 5 safety classifier blocks (400) — retry with Opus 5
      if (res.status === 400 && errText.includes('safety') && (process.env.ANTHROPIC_MODEL ?? 'claude-fable-5') === 'claude-fable-5') {
        const fb = await relayFetch(`${ANTHROPIC_BASE}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 800, temperature: 0.4, ...(systemMsg ? { system: [{ type: 'text', text: systemMsg.content }] } : {}), messages: anthropicMessages }),
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null);
        if (fb?.ok) {
          const fd: unknown = await fb.json().catch(() => null);
          if (fd && typeof fd === 'object' && 'content' in fd) {
            const fc = (fd as { content: Array<Record<string, unknown>> }).content;
            return typeof fc[0]?.text === 'string' ? fc[0].text : null;
          }
        }
      }
      return null;
    }

    const data: unknown = await res.json();
    if (
      data !== null &&
      typeof data === 'object' &&
      'content' in data &&
      Array.isArray((data as Record<string, unknown>).content)
    ) {
      const content = (data as { content: Array<Record<string, unknown>> }).content;
      const item = content[0];
      return typeof item?.text === 'string' ? item.text : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── YandexGPT Lite (Yandex Cloud) ─────────────────────────────
// Лучший по русскому языку. Без геоблока для России.
// Env: YANDEX_API_KEY (Api-Key), YANDEX_FOLDER_ID (каталог YC)
export async function callYandexGPT(messages: ChatMessage[]): Promise<string | null> {
  const yandex = getYandexKey();
  if (!yandex) return null;
  const { apiKey, folderId } = yandex;

  try {
    // YandexGPT использует `text` вместо `content`
    const yMessages = messages
      .filter((m) => m.role !== 'system')
      .map(({ role, content }) => ({
        role: role === 'assistant' ? 'assistant' : 'user',
        text: content,
      }));

    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      yMessages.unshift({ role: 'system', text: systemMsg.content });
    }

    const res = await fetch(
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Api-Key ${apiKey}`,
          'x-folder-id': folderId,
        },
        body: JSON.stringify({
          modelUri: `gpt://${folderId}/yandexgpt-5.1/latest`,
          completionOptions: {
            stream: false,
            temperature: 0.4,
            maxTokens: '800',
          },
          messages: yMessages,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined =
      data?.result?.alternatives?.[0]?.message?.text;
    return text?.trim() || null;
  } catch {
    return null;
  }
}

// Gemini зовётся напрямую через Google API (`callGeminiDirect`, ниже) — так
// он и стоит в водопаде. Вариант через OpenRouter (`callGemini`) не звал
// никто; удалён 22.08.2026.

// ── DeepSeek (direct API) ──────────────────────────────────────
export async function callDeepSeek(
  messages: ChatMessage[],
  opts?: FastCallOptions,
): Promise<string | null> {
  const apiKey = getDeepSeekKey();
  if (!apiKey) { recordAiLegFailure('deepseek', 'no_key'); return null; }

  try {
    const model = await resolveDeepSeekModel();
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: opts?.maxTokens ?? 800,
        messages: payload,
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
        ...deepseekThinking(),
      }),
    }, { timeoutMs: opts?.timeoutMs ?? 20_000, label: 'deepseek' });
    if (!res.ok) {
      recordAiLegFailure('deepseek', httpFailureReason(res.status, await res.text().catch(() => '')));
      return null;
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    // Обрыв по потолку — отказ ступени, не ответ (completionTruncated, 26.09):
    // в гонке водопада его место займёт целый ответ другого провайдера, а
    // человеку в чате фраза про медведя, оборванная на полуслове, хуже её
    // отсутствия.
    if (text?.trim() && completionTruncated(data)) {
      logLLMUsage(answeredModel(model, data), data.usage);
      recordAiLegFailure('deepseek', `truncated (${model}): finish_reason=length, ответ ${text.length} знаков при maxTokens=${opts?.maxTokens ?? 800}`);
      return null;
    }
    if (text?.trim()) {
      logLLMUsage(answeredModel(model, data), data.usage);
      return text;
    }
    recordAiLegFailure('deepseek', `empty (${model}): ${describeEmptyCompletion(data)}`);
    return null;
  } catch (e) { recordAiLegFailure('deepseek', errorFailureReason(e)); return null; }
}

// ── Moonshot (Kimi) — OpenAI-совместимый, достижим из РФ ───────
// Третий китайский провайдер (после DeepSeek/Qwen) на случай их немоты:
// решатель эволюции и судья фактгейта ходят через DeepSeek/Qwen, и когда те
// молчат — эволюция без предложений, а после «сбой судьи = отмена» (#928)
// Scout вообще не публикует. Kimi K3 — #4 в мире по общим задачам и, в
// отличие от Claude/GPT, не гео-блокируется из Timeweb.
//
// Подготовка (01.08): нет MOONSHOT_API_KEY → callKimi возвращает null и
// молча выпадает из гонки/вотерфолла, поведение байт-в-байт прежнее. Владелец
// кладёт ключ на Timeweb — Kimi оживает и в судье, и в решателе. id модели не
// хардкодим (§8): MOONSHOT_MODEL → pickBestModel(/v1/models) → алиас 'kimi-k3'.
const MOONSHOT_BASE = (process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/+$/, '');
const MOONSHOT_FALLBACK_MODEL = 'kimi-k3';

async function resolveKimiModel(): Promise<string> {
  if (process.env.MOONSHOT_MODEL) return process.env.MOONSHOT_MODEL;
  const cached = PURPOSE_MODEL_CACHE.get('decision:moonshot');
  if (cached && Date.now() - cached.at < DECISION_MODEL_TTL_MS) return cached.id;
  const key = getMoonshotKey();
  if (!key) return MOONSHOT_FALLBACK_MODEL;
  const ids = await fetchModelIds(`${MOONSHOT_BASE}/models`, key);
  const picked = pickBestModel(ids) ?? MOONSHOT_FALLBACK_MODEL;
  if (ids.length) PURPOSE_MODEL_CACHE.set('decision:moonshot', { id: picked, at: Date.now() });
  return picked;
}

/**
 * Один вызов Kimi (OpenAI-совместимый). Нет ключа → null (выпадает из гонки).
 * Зеркалит callDeepSeek: та же форма запроса/ответа, свой timeout.
 */
export async function callKimi(
  messages: ChatMessage[],
  opts?: FastCallOptions,
): Promise<string | null> {
  const apiKey = getMoonshotKey();
  if (!apiKey) { recordAiLegFailure('kimi', 'no_key'); return null; }
  try {
    const model = await resolveKimiModel();
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry(`${MOONSHOT_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0.4,
        max_tokens: opts?.maxTokens ?? 800,
        messages: payload,
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    }, { timeoutMs: opts?.timeoutMs ?? 20_000, label: `kimi:${model}` });
    if (!res.ok) {
      recordAiLegFailure('kimi', httpFailureReason(res.status, await res.text().catch(() => '')));
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: ProviderUsage };
    const text = data?.choices?.[0]?.message?.content;
    if (text?.trim()) { logLLMUsage(`kimi:${answeredModel(model, data)}`, data.usage); return text; }
    recordAiLegFailure('kimi', 'empty');
    return null;
  } catch (e) { recordAiLegFailure('kimi', errorFailureReason(e)); return null; }
}

// ── Qwen (Alibaba DashScope — OpenAI-совместимый) ─────────────
// Китайский провайдер, доступен из РФ (как DeepSeek), сильный агентный
// tool-calling. База и модель — из env: QWEN_BASE_URL (default
// dashscope-intl — интернациональный шлюз), QWEN_MODEL (default qwen-plus).
// Сменить регион-шлюз или тир (qwen-plus/qwen-max) — без правки кода.
export function getQwenConfig(): { apiKey: string | null; base: string; model: string } {
  return {
    apiKey: process.env.DASHSCOPE_API_KEY || null,
    // trim(): значение из панели Timeweb нередко приезжает с хвостовым
    // пробелом/переводом строки — строгое сравнение шлюзов в probeQwenRegions
    // на таком «другом» URL честно, но бесполезно ругалось (кейс 08.08:
    // владелец поставил верный intl-шлюз, а health твердил «настроен другой»).
    base: (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').trim().replace(/\/+$/, ''),
    model: process.env.QWEN_MODEL || 'qwen-plus',
  };
}

export async function callQwen(
  messages: ChatMessage[],
  opts: { maxTokens?: number } = {},
): Promise<string | null> {
  const { apiKey, base } = getQwenConfig();
  if (!apiKey) { recordAiLegFailure('qwen', 'no_key'); return null; }
  // 800 по умолчанию — чат Кузьмича; структурные ответы (JSON-массив
  // предложений эволюции) просят больше явно, иначе рвутся на полуслове.
  const maxTokens = opts.maxTokens ?? 800;

  // Сильнейшая доступная, а не прибитый средний тир (CLAUDE.md §8). Кончилась
  // бесплатная квота у сильнейшей — резолвер её пропускает, и тот же вызов
  // идёт на следующую (25.09, lib/ai/qwen-free-quota).
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = await resolveChatModel('qwen');
    if (isMarkedExhausted(model)) break;
    try {
      const payload = messages.map(({ role, content }) => ({ role, content }));
      const res = await fetchWithRetry(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: maxTokens,
          messages: payload,
        }),
      }, { timeoutMs: 25_000, label: `qwen:${model}` });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (isFreeQuotaExhausted(res.status, body)) { markFreeQuotaExhausted(model); continue; }
        recordAiLegFailure('qwen', httpFailureReason(res.status, body));
        return null;
      }
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: ProviderUsage;
      };
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      if (text?.trim()) {
        logLLMUsage(`qwen:${answeredModel(model, data)}`, data.usage);
        return text;
      }
      recordAiLegFailure('qwen', 'empty');
      return null;
    } catch (e) { recordAiLegFailure('qwen', errorFailureReason(e)); return null; }
  }
  recordAiLegFailure('qwen', `free_quota_exhausted: ${exhaustedModels().join(', ')}`);
  return null;
}

// ── Решатель агентов эволюции ─────────────────────────────────
// Сильные модели, достижимые из РФ НАПРЯМУЮ (без релея): DeepSeek — первичный,
// Qwen — на подхвате. БЕЗ привязки к id: модель определяется автоматически из
// /v1/models провайдера (pickBestModel — сильнейшая общая, без reasoner/vl/…).
// Провайдер сменит линейку — решатель сам подхватит новейшую. Ручной override
// через env EVO_DECISION_MODEL / EVO_DECISION_QWEN_MODEL остаётся как escape.
// Заменяет прежний слабый gemini-2.0-flash в aiCodeReview/generateSuggestion/
// intel-bridge. Последовательно: качество важнее latency (крон).

interface ModelCacheEntry { id: string; at: number }
const PURPOSE_MODEL_CACHE = new Map<string, ModelCacheEntry>();
const DECISION_MODEL_TTL_MS = 60 * 60 * 1000; // 1ч
// Крайний фоллбэк, если /v1/models недоступен. НЕ «безопасный алиас»:
// 26.07.2026 DeepSeek вывел deepseek-chat из эксплуатации (HTTP 400:
// «supported API model names are deepseek-v4-pro or deepseek-v4-flash»), и
// «вечный» алиас умер вместе с линейкой v3. Значение ниже — из текста той
// самой ошибки провайдера, и оно ТОЖЕ протухнет: это последняя соломинка на
// случай недоступного /models, а не рабочий путь. Рабочий путь — резолв.
/**
 * DeepSeek V4 ДУМАЕТ по умолчанию — и на этом лёг весь прямой путь.
 *
 * Замер ai-debug run 6-7 (04.09): deepseek-v4-pro и v4-flash на обычный
 * запрос отвечают HTTP 200 с `finish_reason=length`, reasoning_content
 * 575-686 знаков и ПУСТЫМ content — размышление съедает бюджет max_tokens,
 * до ответа дело не доходит. Чат Кузьмича (800 токенов) на коротких
 * промптах ещё пролезал, судья (1600) и решатель (1500) на длинных — нет:
 * «deepseek: content empty», synthesis_null, decision_null.
 *
 * Рычаг выбран измерением, а не догадкой (документацию DeepSeek из РФ и из
 * песочницы не прочесть): `thinking: {type:'disabled'}` — обе модели
 * отвечают за ~320 мс; max_tokens 2000 тоже спасает, но платит за
 * размышление токенами и временем. Живой путь просит ответ без
 * размышления. Override — DEEPSEEK_THINKING=1: тогда бюджет ответа
 * (max_tokens с запасом на reasoning) — забота вызывающего.
 */
export function deepseekThinking(purpose: 'fast' | 'deep' = 'fast'): Record<string, unknown> {
  if (process.env.DEEPSEEK_THINKING === '1') return {};
  if (process.env.DEEPSEEK_THINKING === '0') return { thinking: { type: 'disabled' } };
  return purpose === 'deep' ? {} : { thinking: { type: 'disabled' } };
}

/**
 * Бюджет ответа, когда модель РАЗМЫШЛЯЕТ.
 *
 * Замечание владельца 04.09: «все модели отвечают с глубоким анализом только
 * на 3-4 раз, первые ответы поверхностные». Одну из причин я внёс сам этим
 * утром: выключил размышление ВЕЗДЕ, чтобы вылечить пустой content, — а
 * замер показывал ДВА рабочих рычага, и второй (больший бюджет) размышление
 * сохраняет. Для живого чата выбор верен: человек ждёт, и 800 токенов ответа
 * дороже раздумий. Для ночного крона, пишущего текст людям, — нет: там
 * глубина и есть смысл работы.
 *
 * max_tokens у DeepSeek считает размышление ВМЕСТЕ с ответом (04.09:
 * finish_reason=length при 200 токенах и пустом content, reasoning 575-686
 * знаков). Значит потолок обязан покрывать оба, иначе включённое размышление
 * снова съест ответ целиком — ту самую немоту мы сегодня и чинили.
 */
export function deepThinkingBudget(answerTokens: number): number {
  return answerTokens + 1500;
}

/**
 * Имя модели для прямого Anthropic API, выведенное из слага OpenRouter.
 *
 * Запасной путь на случай, когда каталог самого Anthropic не ответил. Работает
 * ТОЛЬКО для anthropic'овских слагов: снятие префикса у `anthropic/claude-...`
 * даёт осмысленный id, у чужого слага — не даёт ничего.
 *
 * Правило появилось 15.09 по следу в отчёте судьи (#1428): строка
 * `flagshipModel.replace(/^anthropic\//, '')` писалась тогда, когда флагман
 * ВСЕГДА был моделью Anthropic. С 09.09 вендор задаётся переменной
 * (`EVO_DECISION_FLAGSHIP_VENDOR: z-ai`), и до этой строки смена не доехала:
 * `z-ai/glm-5.3` префикса не имеет, replace его не трогает, и в
 * `api.anthropic.com/v1/messages` уходило `model: "z-ai/glm-5.3"` — модель
 * чужого поставщика. В отчёте это читалось как `anthropic(z-ai/glm-5.3): HTTP
 * 401` и выглядело отказом ключа; ключ там и правда отвергнут, но запрос был
 * бессмысленным независимо от ключа.
 *
 * `null` — честное «просить нечего» (§4.0): ступень пропускается с названной
 * причиной, а не тратит запрос на заведомо неверное имя.
 */
export function anthropicModelFromSlug(flagshipSlug: string): string | null {
  const PREFIX = 'anthropic/';
  if (!flagshipSlug.startsWith(PREFIX)) return null;
  const id = flagshipSlug.slice(PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

const DECISION_FALLBACK: Record<'deepseek' | 'qwen', string> = {
  // deepseek-chat — стабильный chat-id DeepSeek (V3). Раньше здесь стоял
  // deepseek-v4-pro, но на chat/completions он возвращал пустой body (полевой
  // прогон 02.08 → решатель нем). Страховка обязана быть заведомо рабочей.
  deepseek: 'deepseek-chat',
  qwen: 'qwen-max-latest',
};

/**
 * Действующая chat-модель DeepSeek — через /v1/models, БЕЗ хардкода id.
 *
 * До 26.07.2026 весь прямой путь DeepSeek (waterfall, health-проба, tools,
 * debug) хардкодил 'deepseek-chat' и лёг целиком в момент, когда провайдер
 * сменил линейку. Диагностика из health назвала причину за минуты — но
 * чинить хардкод хардкодом значит повторить это через полгода. Override —
 * env DEEPSEEK_MODEL.
 */
export async function resolveDeepSeekModel(): Promise<string> {
  return resolveBestModel('deepseek', 'chat', process.env.DEEPSEEK_MODEL);
}

async function fetchModelIds(url: string, apiKey: string): Promise<string[]> {
  try {
    // relayFetchWithRetry, а не голый: сюда приходит и ${OPENROUTER_BASE}/models,
    // который при настроенном релее ведёт не на openrouter.ai. Секрет добавится
    // сам, а на прямой адрес не уйдёт.
    const res = await relayFetchWithRetry(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, { timeoutMs: 12_000, maxRetries: 1, baseDelayMs: 500, label: 'models-list' });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id?: unknown }> };
    return (data?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
  } catch { return []; }
}

/**
 * Список id моделей OpenRouter — все поставщики разом, с префиксами вида
 * `openai/…`, `anthropic/…`, `google/…`.
 *
 * Нужен ровно потому, что до 19.08 «сильнейший флагман» подбирался ТОЛЬКО
 * среди моделей Anthropic: `resolveFlagshipModel` спрашивал их список и
 * приклеивал префикс `anthropic/`. Комментарий обещал «Claude/GPT», а по
 * построению выбрать GPT было нельзя — сколько бы он ни стоил и как бы ни
 * считался сильнее. Нет ключа или недоступен — пустой список, и решатель
 * возвращается к прежнему поведению.
 */
export async function getOpenRouterModelIds(): Promise<string[]> {
  const key = getOpenRouterKey();
  return key ? fetchModelIds(`${OPENROUTER_BASE}/models`, key) : [];
}

/**
 * Список id моделей Anthropic из /v1/models. Заголовок авторизации у Anthropic
 * иной (x-api-key + anthropic-version), поэтому не через fetchModelIds. Работает
 * и через релей (ANTHROPIC_BASE_URL). Нет ключа/недостижим → пустой список.
 */
export async function getAnthropicModelIds(): Promise<string[]> {
  const probe = await probeAnthropicModels();
  if (probe.ok) return probe.ids;
  // §4.0: ловить можно, молчать нельзя. Снисходительность к живому пути
  // (падаем на алиас) не даёт права молчать о причине — иначе отказ каталога
  // доходит до человека как «каталог пуст», и чинить он пойдёт не то.
  console.error(`[anthropic-models] каталог не ответил: ${probe.http_status ?? 'сеть'} ${probe.detail}`);
  return [];
}

/**
 * Каталог Anthropic С ОТЛИЧИМЫМ ОТКАЗОМ — тот же приём, что у
 * `probeProviderModels` для DeepSeek и Qwen.
 *
 * До 18.09 `getAnthropicModelIds` отвечал пустым списком на ТРИ разных
 * события: ключа нет, каталог отказал по HTTP, запрос не дошёл. Ступень
 * Anthropic в решателе печатала по нему одну строку — «каталог моделей
 * пуст», — и она попадала в отчёт судьи (#1428) как факт о ключе. Факта о
 * ключе там не было вовсе: спросить не смогли.
 *
 * Цена этой подмены выросла в тот день, когда владелец пополнил счёт
 * Anthropic: отчёт сказал бы ровно то же самое «каталог пуст», и вывод
 * «деньги не помогли» был бы сделан по замеру, которого не было.
 */
export async function probeAnthropicModels(): Promise<
  | { ok: true; ids: string[] }
  | { ok: false; http_status: number | null; detail: string }
> {
  const key = getAnthropicKey();
  if (!key) return { ok: false, http_status: null, detail: 'ключ не задан' };
  try {
    const res = await relayFetchWithRetry(`${ANTHROPIC_BASE}/v1/models?limit=100`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }, { timeoutMs: 12_000, maxRetries: 1, baseDelayMs: 500, label: 'anthropic-models-list' });
    if (!res.ok) {
      return { ok: false, http_status: res.status, detail: (await res.text()).slice(0, 300) };
    }
    const data = await res.json() as { data?: Array<{ id?: unknown }> };
    return {
      ok: true,
      ids: (data?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string'),
    };
  } catch (err) {
    return { ok: false, http_status: null, detail: err instanceof Error ? err.message : 'запрос не удался' };
  }
}

/**
 * Список моделей провайдера С ОТЛИЧИМЫМ ОТКАЗОМ — для диагностики.
 *
 * `getProviderModelIds` ниже намеренно снисходителен: он глотает ошибку и
 * отдаёт пустой список, потому что зовущий его резолвер всё равно упадёт на
 * безопасный алиас, и это верное поведение живого пути.
 *
 * Диагностике так нельзя. «У ключа нет ни одной модели» и «мы не смогли
 * спросить» — разные ответы, и человек, читающий пустой список как первое,
 * пойдёт чинить не то. Поэтому здесь третий исход назван вслух (§4.0).
 */
export async function probeProviderModels(
  provider: 'deepseek' | 'qwen',
): Promise<
  | { ok: true; ids: string[] }
  | { ok: false; http_status: number | null; detail: string }
> {
  const url = provider === 'deepseek'
    ? 'https://api.deepseek.com/models'
    : `${getQwenConfig().base}/models`;
  const key = provider === 'deepseek' ? getDeepSeekKey() : getQwenConfig().apiKey;
  if (!key) return { ok: false, http_status: null, detail: 'ключ не задан' };

  try {
    const res = await relayFetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, http_status: res.status, detail: (await res.text()).slice(0, 300) };
    }
    const data = await res.json() as { data?: Array<{ id?: unknown }> };
    return {
      ok: true,
      ids: (data?.data ?? []).map(m => m.id).filter((x): x is string => typeof x === 'string'),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'запрос не удался';
    return { ok: false, http_status: null, detail };
  }
}

/** Список id моделей провайдера из /v1/models (для решателя и model-watcher). */
export async function getProviderModelIds(provider: 'deepseek' | 'qwen'): Promise<string[]> {
  if (provider === 'deepseek') {
    const key = getDeepSeekKey();
    return key ? fetchModelIds('https://api.deepseek.com/models', key) : [];
  }
  const { apiKey, base } = getQwenConfig();
  return apiKey ? fetchModelIds(`${base}/models`, apiKey) : [];
}

let qwenCatalogCache: string[] | null = null;
let qwenCatalogAt = 0;

/**
 * Модель цикла инструментов: настроенная, а если её бесплатная квота кончилась —
 * её же снимок или алиас `-latest` (lib/ai/qwen-free-quota). Каталог
 * спрашивается только после отметки: пока настроенная жива, живой путь лишнего
 * round-trip не платит. `null` — квота кончилась у всех замен.
 */
export async function nextQwenToolsModel(configured: string): Promise<string | null> {
  if (!isMarkedExhausted(configured)) return configured;
  if (!qwenCatalogCache || Date.now() - qwenCatalogAt >= DECISION_MODEL_TTL_MS) {
    const ids = await getProviderModelIds('qwen');
    // Пустой список — «не смогли спросить», а не «замен нет»: не кэшируем.
    if (ids.length) { qwenCatalogCache = ids; qwenCatalogAt = Date.now(); }
  }
  return firstUnexhausted(freeQuotaSiblings(configured, qwenCatalogCache ?? []));
}

/**
 * Автоопределение сильнейшей модели провайдера без привязки к id:
 * env-override → кэш → /v1/models + pickBestModel → безопасный алиас.
 * Кэш 1ч, чтобы не дёргать список на каждый вызов.
 *
 * Ключ кэша включает назначение: у решателя и у контента разные override,
 * и подсовывать одному кэш другого нельзя.
 */
async function resolveBestModel(
  provider: 'deepseek' | 'qwen',
  purpose: 'decision' | 'content' | 'chat',
  override: string | undefined,
): Promise<string> {
  if (override) return override;

  const cacheKey = `${purpose}:${provider}` as const;
  const cached = PURPOSE_MODEL_CACHE.get(cacheKey);
  // Модель с исчерпанной бесплатной квотой из кэша не отдаём (25.09): иначе
  // час после отметки вызов стучался бы в ту же стену.
  if (cached && Date.now() - cached.at < DECISION_MODEL_TTL_MS && !isMarkedExhausted(cached.id)) return cached.id;

  const ids = (await getProviderModelIds(provider)).filter((id) => !isMarkedExhausted(id));
  const picked = pickBestModel(ids) ?? DECISION_FALLBACK[provider];
  PURPOSE_MODEL_CACHE.set(cacheKey, { id: picked, at: Date.now() });
  return picked;
}

export async function resolveDecisionModel(provider: 'deepseek' | 'qwen'): Promise<string> {
  return resolveBestModel(provider, 'decision', provider === 'deepseek'
    ? process.env.EVO_DECISION_MODEL
    : process.env.EVO_DECISION_QWEN_MODEL);
}

/**
 * Модель для ГЕНЕРАЦИИ КОНТЕНТА (дайджест, описания Editor, посты в каналы).
 *
 * До 25.07.2026 такого понятия не было: контент писал callAIFast — гонка трёх
 * провайдеров, где побеждает самый БЫСТРЫЙ, а не самый сильный. Двое из трёх
 * были прибиты к снапшотам начала 2025 года (gemini-2.0-flash-001,
 * deepseek-chat-v3-0324). Быстрая мелкая модель выигрывала гонку почти всегда,
 * и публичные тексты писала она. Отсюда «наша LLM не дотягивает».
 *
 * Здесь id не хардкодится сознательно (CLAUDE.md §8): провайдер обновит
 * линейку — pickBestModel подхватит сам, и разговор не повторится через
 * полгода. Override — CONTENT_MODEL / CONTENT_QWEN_MODEL.
 */
export async function resolveContentModel(provider: 'deepseek' | 'qwen'): Promise<string> {
  return resolveBestModel(provider, 'content', provider === 'deepseek'
    ? process.env.CONTENT_MODEL
    : process.env.CONTENT_QWEN_MODEL);
}

/** Диагностика одного пути релея: статус, найден ли текст в ОЖИДАЕМОЙ форме, тело. */
export interface RelayProbeLeg {
  base: string;
  key_set: boolean;
  http_status: number | null;
  /** Распарсился ли текст той же формой, что читает решатель (иначе «пустой ответ»). */
  text_found: boolean;
  /** Кусок сырого тела — виден настоящий ответ релея (форма/ошибка-в-200/лимит). */
  body_sample: string;
}

/**
 * Проб флагманского релея. Немота решателя показывала «пустой ответ» и по
 * OpenRouter, и по Anthropic — но это значит «релей ответил 200, а текста в
 * ожидаемой форме нет», а НЕ «релея нет». Существующие пробы (probeAnthropic,
 * probeOpenRouterKeyStatus) проверяют доступность/ключ, но не то, что ответ
 * парсится формой решателя. Этот проб повторяет РОВНО разбор решателя
 * (OpenAI: choices[].message.content · Anthropic: content[].text) и кладёт
 * сырое тело — чтобы сразу увидеть: несовпадение формы, ошибка-в-200, неверная
 * модель или лимит. Admin-only (GET /api/admin/ai/probe-relay).
 */
export async function probeFlagshipRelay(): Promise<{
  flagship_model: string;
  openrouter: RelayProbeLeg;
  anthropic: RelayProbeLeg;
}> {
  const flagshipModel = await resolveFlagshipModel();
  const probeMsg = [{ role: 'user', content: 'Ответь одним словом: ok' }];

  // OpenRouter-путь — OpenAI-форма (choices[].message.content).
  const orKey = getOpenRouterKey();
  const openrouter: RelayProbeLeg = { base: OPENROUTER_BASE, key_set: !!orKey, http_status: null, text_found: false, body_sample: orKey ? '' : 'ключ не задан' };
  if (orKey) {
    try {
      const res = await relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}`, ...openRouterAttribution() },
        body: JSON.stringify({ model: flagshipModel, max_tokens: 16, messages: probeMsg }),
        signal: AbortSignal.timeout(15_000),
      });
      openrouter.http_status = res.status;
      const raw = await res.text();
      openrouter.body_sample = raw.slice(0, 400);
      try { const d = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }; openrouter.text_found = !!d?.choices?.[0]?.message?.content?.trim(); } catch { /* тело не JSON — body_sample покажет */ }
    } catch (e) { openrouter.body_sample = `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`; }
  }

  // Anthropic-путь — Anthropic-форма (content[].text). Модель без префикса
  // anthropic/ — и ТОЛЬКО если флагман действительно anthropic'овский.
  //
  // Здесь тот же дефект, что в решателе (#1428), но цена у него своя и выше:
  // это ДИАГНОСТИКА. С флагманом `z-ai/glm-5.3` (вендор задаётся переменной с
  // 09.09) снятие префикса ничего не снимало, и проба спрашивала
  // api.anthropic.com про модель чужого поставщика. Ответ — отказ, и проба
  // объявляла путь нерабочим, когда на самом деле она не смогла его
  // проверить. Пополнили счёт, запустили проверку, получили «не помогло» —
  // и решение принято по замеру, которого не было (§4.0).
  const antKey = getAnthropicKey();
  const antModel = anthropicModelFromSlug(flagshipModel);
  const anthropic: RelayProbeLeg = {
    base: ANTHROPIC_BASE,
    key_set: !!antKey,
    http_status: null,
    text_found: false,
    body_sample: !antKey ? 'ключ не задан'
      : !antModel ? `флагман ${flagshipModel} — не модель Anthropic: id для запроса взять неоткуда, путь НЕ проверен`
      : '',
  };
  if (antKey && antModel) {
    try {
      const res = await relayFetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': antKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: antModel, max_tokens: 16, messages: probeMsg }),
        signal: AbortSignal.timeout(15_000),
      });
      anthropic.http_status = res.status;
      const raw = await res.text();
      anthropic.body_sample = raw.slice(0, 400);
      try { const d = JSON.parse(raw) as { content?: Array<{ text?: string }> }; anthropic.text_found = !!d?.content?.[0]?.text?.trim(); } catch { /* тело не JSON — body_sample покажет */ }
    } catch (e) { anthropic.body_sample = `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`; }
  }

  return { flagship_model: flagshipModel, openrouter, anthropic };
}

/**
 * Модель для ОДИНОЧНОГО вызова провайдера вне гонки (callQwen).
 *
 * Последний путь, где id ещё был прибит: `QWEN_MODEL || 'qwen-plus'` — средний
 * тир, тогда как решатель и контент рядом уже брали сильнейшее из /v1/models.
 * Значение имело: на callQwen висела первая фаза scout-innovator, которая
 * рождает предложения эволюции, — там качество модели превращалось в качество
 * задач. С 08.09 по 24.09 та фаза шла мимо Qwen (ключ был отвергнут); 24.09
 * владелец вернул Qwen в текстовые пути, и первая фаза снова начинается с него.
 * Второй вызов callQwen — проба ключа DashScope в health-кроне.
 *
 * Назначение 'chat' — свой ключ кэша, чтобы override одного пути не протекал в
 * другой. Override сохранён прежним (`QWEN_MODEL`): у кого он выставлен, ничего
 * не меняется. Живой tools-цикл Кузьмича сюда НЕ подключён сознательно: там
 * ждёт человек, а резолв — лишний round-trip на холодном кэше.
 */
export async function resolveChatModel(provider: 'deepseek' | 'qwen'): Promise<string> {
  return resolveBestModel(provider, 'chat', provider === 'deepseek'
    ? process.env.CHAT_MODEL
    : process.env.QWEN_MODEL);
}

// Флагман-решатель эволюции: сильнейшая ОБЩАЯ модель, доступная по пути
// вызова. У флагманов меньше галлюцинаций, но из РФ (Timeweb) openrouter.ai
// гео-блокируется — достижимы ТОЛЬКО через релей (OPENROUTER_BASE_URL на
// Cloudflare Worker/VPS вне РФ). С раннера GitHub релей не нужен: он вне РФ.
//
// До 19.08 «флагман» выбирался только среди моделей Anthropic, хотя строка
// выше обещала «Claude/GPT»: список брался у Anthropic и получал префикс
// `anthropic/`. Модель другого поставщика не могла быть выбрана по
// построению. Теперь каталог берётся у OpenRouter — там все поставщики сразу.
//
// ── Где проходит граница догадки ──────────────────────────────────────────
//
// Соблазн: раз каталог полон, пусть оценщик выберет сильнейшую вообще. Так
// нельзя, и измерение это показало. Лестница тиров калибрована под ИМЕНА
// Anthropic: слово `opus` даёт тир 6, а простой `gpt-6` попадает в нейтральный
// тир 3 — и проигрывает `claude-opus-4-5`, будучи старше версией. Не потому,
// что слабее, а потому что у OpenAI флагман не носит слова-тира.
//
// Починить лестницу «поровну» невозможно: сила модели ПО ИМЕНИ не выводится.
// `gpt-6` против `claude-5` — числа разных вендоров, они несравнимы, и всякая
// формула поверх них будет догадкой в одежде измерения. Ровно этого мы весь
// день избегаем.
//
// Поэтому: сильнейшая ВНУТРИ поставщика — это измеримо (одна линейка, одни
// слова, одна нумерация), а выбор поставщика — решение владельца, и он задаётся
// переменной EVO_DECISION_FLAGSHIP_VENDOR (по умолчанию anthropic).
//
// Привязки к конкретному id по-прежнему нет (CLAUDE.md §8): внутри поставщика
// подбор идёт оценкой, а не перечнем, и новая линейка подхватится сама. Ручной
// override целиком — EVO_DECISION_FLAGSHIP_MODEL. Пин ниже — крайний фоллбэк,
// когда авто-резолв недоступен вовсе.
const EVO_FLAGSHIP_FALLBACK = 'anthropic/claude-opus-5';

/**
 * Сильнейший флагман БЕЗ привязки к id (CLAUDE.md §8) — как для DeepSeek/Qwen.
 * env override → кэш → Anthropic /v1/models + pickBestFlagship → пин-фоллбэк.
 * Возвращает id с префиксом anthropic/ (для OpenRouter-пути; Anthropic-прямой
 * путь сам срежет префикс). Раньше флагман был прибит к 'claude-opus-5' и не
 * подхватывал новую линейку (Opus 6…) без правки кода — теперь подхватит сам.
 */
export async function resolveFlagshipModel(): Promise<string> {
  const override = process.env.EVO_DECISION_FLAGSHIP_MODEL;
  if (override) return override;

  const cached = PURPOSE_MODEL_CACHE.get('decision:flagship');
  if (cached && Date.now() - cached.at < DECISION_MODEL_TTL_MS) return cached.id;

  // Каталог OpenRouter — модели ВСЕХ поставщиков, уже с префиксами. Выбор
  // идёт ВНУТРИ предпочтённого поставщика, а не между ними: см. пояснение о
  // границе догадки над функцией. Поставщик задаётся одной переменной.
  const vendor = (process.env.EVO_DECISION_FLAGSHIP_VENDOR || 'anthropic').trim().toLowerCase();
  const routed = await getOpenRouterModelIds();
  const pickedRouted = routed.length > 0 ? pickBestFlagship(routed, `${vendor}/`) : null;
  if (pickedRouted) {
    // Каталог OpenRouter уже несёт префикс поставщика — второй не клеим.
    PURPOSE_MODEL_CACHE.set('decision:flagship', { id: pickedRouted, at: Date.now() });
    return pickedRouted;
  }

  const ids = await getAnthropicModelIds();
  const picked = pickBestFlagship(ids);
  const resolved = picked ? `anthropic/${picked}` : EVO_FLAGSHIP_FALLBACK;
  // Кэшируем только реальный резолв, не фоллбэк — чтобы недоступность не
  // «залипала» на час и авто-резолв поднялся, как только ключ/релей появятся.
  if (picked) PURPOSE_MODEL_CACHE.set('decision:flagship', { id: resolved, at: Date.now() });
  return resolved;
}

/**
 * Шлюз Timeweb к флагманам — БЕЗ хопа за границей (CLAUDE.md §8, замер 23.08).
 * У него модель — свойство агента: URL несёт agent_id, `model` в теле
 * запроса игнорируется. Формат `Authorization` не задокументирован дословно —
 * см. коммент к getTimewebAgents(); если он неверен, ответ будет 401, не
 * таймаут, и это отличимо через probeTimewebAgentStatus().
 */
export const TIMEWEB_AGENT_BASE = 'https://agent.timeweb.cloud/api/v1/cloud-ai/agents';

export async function callTimewebAgent(
  agent: TimewebAgent,
  messages: ChatMessage[],
): Promise<{ text: string | null; httpStatus: number | null; detail: string }> {
  try {
    const res = await relayFetchWithRetry(`${TIMEWEB_AGENT_BASE}/${agent.agentId}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.token}` },
      // `model` шлюз игнорирует (модель — настройка агента), но поле шлём —
      // OpenAI-совместимые серверы обычно требуют его в теле.
      body: JSON.stringify({ model: 'agent', temperature: 0.2, max_tokens: 2000, messages }),
    }, { timeoutMs: 45_000, label: `timeweb-agent:${agent.agentId}` });

    const bodyText = await res.text().catch(() => '');
    if (!res.ok) return { text: null, httpStatus: res.status, detail: bodyText.slice(0, 200) };

    const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }>; usage?: ProviderUsage };
    const text = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(`timeweb:${agent.agentId}`, data.usage);
      return { text, httpStatus: res.status, detail: '' };
    }
    return { text: null, httpStatus: res.status, detail: 'пустой ответ' };
  } catch (e) {
    return { text: null, httpStatus: null, detail: e instanceof Error ? e.message.slice(0, 150) : 'error' };
  }
}

/**
 * Живая диагностика шлюза — health-эндпоинт зовёт это, а не гадает по логам
 * решателя. Пусто/не настроено → пустой массив (не ошибка: шлюз опционален,
 * владелец подключает его сам, создавая агентов в панели Timeweb).
 */
export async function probeTimewebAgentStatus(): Promise<Array<{
  name: string;
  agent_id: string;
  http_status: number | null;
  detail: string;
}>> {
  const agents = getTimewebAgents();
  const entries = Object.entries(agents);
  if (entries.length === 0) return [];

  return Promise.all(entries.map(async ([name, agent]) => {
    const r = await callTimewebAgent(agent, [{ role: 'user', content: 'ping' }]);
    return { name, agent_id: agent.agentId, http_status: r.httpStatus, detail: r.text ? 'ok' : r.detail };
  }));
}

/** Ответ решателя вместе с моделью, которая его дала. */
export interface DecisionResult {
  text: string | null;
  /** Реальная модель ответа: флагман или фоллбэк (deepseek/qwen). null — никто не ответил. */
  model: string | null;
  /** ПОЧЕМУ никто не ответил (по ступеням waterfall) — только при text:null.
      До 01.08 отказы глотались молча, и четыре немых прогона выглядели
      здоровыми; баланс DeepSeek при этом был жив — причина в другом,
      и без этого поля её было не увидеть. */
  error?: string;
  /**
   * Ступени, пройденные ДО выбранной модели, — при любом исходе, не только при
   * немоте (Эволюция 2.0, пакет D). До 08.08 массив причин выбрасывался при
   * успехе, и по прогону нельзя было отличить «флагман-релей не настроен»
   * (штатный DeepSeek, тревога не нужна) от «настроен, но молчит» (понижение,
   * тревога с причиной). Алерт теперь различает эти состояния фактом.
   */
  provenance?: string[];
}

/**
 * Тонкая обёртка: прежний контракт (только текст) для вызывающих, которым
 * модель не нужна.
 */
export async function callAIDecision(messages: ChatMessage[]): Promise<string | null> {
  return (await callAIDecisionDetailed(messages)).text;
}

/**
 * Решатель + АТРИБУЦИЯ модели. Зачем: находки эволюции писались без указания,
 * кто их породил, поэтому гипотезу «галлюцинации из-за слабых фоллбэк-моделей»
 * нельзя было ни подтвердить, ни опровергнуть — waterfall молча съезжает с
 * флагмана на DeepSeek/Qwen, если нет ключа или релея. Теперь модель едет
 * вместе с ответом и штампуется в находку.
 */
export async function callAIDecisionDetailed(messages: ChatMessage[]): Promise<DecisionResult> {
  const payload = messages.map(({ role, content }) => ({ role, content }));
  // Причины отказа по ступеням — едут в DecisionResult.error при полной немоте.
  const why: string[] = [];

  // Сильнейший флагман без привязки к id (авто-резолв из /v1/models, §8).
  const flagshipModel = await resolveFlagshipModel();

  // -1) Флагман через шлюз Timeweb (agent.timeweb.cloud) — пробуем ПЕРВЫМ,
  //     раньше OpenRouter/Anthropic-релея. Причина порядка: у этого пути нет
  //     хопа за границу через сторонний релей, поэтому нет и его гео-блока
  //     (Cloudflare 403) — тот самый отказ, из-за которого ступени ниже
  //     регулярно падают на «ключ есть, ответа нет». Не настроено
  //     (TIMEWEB_AI_AGENTS пуст) → пропускаем молча, как и остальные ступени
  //     без ключа. Среди настроенных агентов берём сильнейшего по имени
  //     (pickBestFlagship — та же логика, что у OpenRouter/Anthropic-каталогов).
  const timewebAgents = getTimewebAgents();
  const timewebNames = Object.keys(timewebAgents);
  if (timewebNames.length === 0) {
    why.push('timeweb: TIMEWEB_AI_AGENTS не задан');
  } else {
    const bestName = pickBestFlagship(timewebNames) ?? timewebNames[0];
    const agent = timewebAgents[bestName];
    const r = await callTimewebAgent(agent, payload);
    if (r.text) {
      return { text: r.text, model: `timeweb:${bestName}`, provenance: why.slice() };
    }
    why.push(`timeweb(${bestName}): ${r.httpStatus !== null ? `HTTP ${r.httpStatus} ` : ''}${r.detail || 'ответа нет'}`);
  }

  // 0) Флагман (Claude/GPT) через relay-aware OpenRouter — приоритет качества.
  //    Нет OPENROUTER_API_KEY / релея → callOpenRouterModel вернёт null, и мы
  //    падаем на DeepSeek/Qwen (прежнее поведение). Активируется автоматически,
  //    когда владелец задаёт ключ+релей на Timeweb.
  //
  // «Нет ключа» и «ключ есть, ответа нет» — РАЗНЫЕ беды, и лечатся они разным:
  // первая заводится в секретах, вторая — деньгами, гео или моделью. Одна
  // строка на оба случая держала разбор в неведении: отчёт 19.08 сорок шесть
  // раз повторил «пустой ответ или нет ключа/релея», не сказав, что именно.
  // Тот же дефект, что мы весь день чиним в других местах, — в собственном логе.
  if (!getOpenRouterKey()) {
    why.push('flagship: OPENROUTER_API_KEY не задан');
  } else {
    try {
      // Причина отказа приходит из самой ступени. Прежняя строка «ключ есть,
      // ответа нет» была честной ровно наполовину: она сообщала ЧТО, но не
      // ПОЧЕМУ, и по ней нельзя было отличить недействительный ключ от
      // исчерпанного счёта или закрытого доступа. Прогон 22.08 повторил её
      // сорок восемь раз — с раннера GitHub, где ни релея, ни гео-блока нет.
      let refusal: string | null = null;
      const flag = await callOpenRouterModel(payload, flagshipModel, {
        timeoutMs: 45_000, temperature: 0.2, maxTokens: 2000,
        onRefusal: ({ status, detail }) => {
          refusal = status === null ? detail : `HTTP ${status} ${detail}`;
        },
      });
      if (flag?.text?.trim()) return { text: flag.text, model: flagshipModel, provenance: why.slice() };
      why.push(`flagship(${flagshipModel}): ${refusal ?? 'ключ есть, ответа нет'}`);
    } catch (e) { why.push(`flagship(${flagshipModel}): ${(e as Error).message.slice(0, 100)}`); }
  }

  // 0b) Флагман НАПРЯМУЮ через Anthropic API (ANTHROPIC_BASE_URL-релей).
  //     Живой случай 2026-07-24: релей до api.anthropic.com работает и ключ
  //     Anthropic есть, а OpenRouter-путь не прошёл — Claude достижим и без
  //     посредника. Модель — та же флагманская (без префикса "anthropic/").
  const antKey = getAnthropicKey();
  if (!antKey) why.push('anthropic: ключа нет');
  if (antKey) {
    // Идентификатор берётся из каталога САМОГО Anthropic, а не из слага
    // OpenRouter со снятым префиксом.
    //
    // Когда ключ OpenRouter есть, resolveFlagshipModel выбирает id из ЕГО
    // каталога — там слаги вида `anthropic/claude-opus-4.6`. Снятие префикса
    // давало `claude-opus-4.6`, а api.anthropic.com такого id не знает: у него
    // `claude-opus-4-8`. Запрос отвечал 400 за доли секунды, и отчёты 16-19.08
    // читались как «Anthropic молчит» — при живом ключе с оплаченным Opus.
    // Разные каталоги — разные имена; общего у них только поставщик.
    /**
     * Запасное имя берётся из слага ТОЛЬКО если слаг — anthropic'овский.
     *
     * Строка `flagshipModel.replace(/^anthropic\//, '')` писалась тогда, когда
     * флагман ВСЕГДА был моделью Anthropic, и снятие префикса было
     * осмысленным. С 09.09 вендор флагмана задаётся переменной
     * (`EVO_DECISION_FLAGSHIP_VENDOR: z-ai`), и до этой строки смена не
     * доехала: `z-ai/glm-5.3` префикса `anthropic/` не имеет, replace его не
     * трогает, и в `api.anthropic.com/v1/messages` уходило поле
     * `model: "z-ai/glm-5.3"` — модель чужого поставщика.
     *
     * В отчёте судьи (#1428) это читалось как `anthropic(z-ai/glm-5.3): HTTP
     * 401` и выглядело отказом ключа. Ключ там и правда отвергнут, но запрос
     * был бессмысленным независимо от ключа: даже с живым и оплаченным
     * ключом Anthropic не знает такого id.
     *
     * Теперь чужой слаг — это честное «не знаю, какую модель просить»: ступень
     * пропускается с названной причиной, а не тратит запрос на заведомо
     * неверное имя (§4.0).
     */
    /**
     * «Каталог пуст» и «каталог не ответил» — разные беды (§4.0).
     *
     * Отчёт судьи 18.09 (#1428) печатал первое, а было второе: спросить не
     * смогли. Читающий видел «пусто» и делал вывод о ключе — о ключе там не
     * было сказано ничего. Теперь причина отказа называется словами
     * провайдера и попадает в тот же отчёт.
     */
    const antProbe = await probeAnthropicModels();
    const antIds = antProbe.ok ? antProbe.ids : [];
    const antModel = pickBestFlagship(antIds) ?? anthropicModelFromSlug(flagshipModel);
    if (!antProbe.ok) {
      const refused = `каталог не ответил (${antProbe.http_status ?? 'сеть'}): ${antProbe.detail.slice(0, 120)}`;
      why.push(antModel
        ? `anthropic: ${refused} — id взят из слага OpenRouter`
        : `anthropic: ${refused}; флагман (${flagshipModel}) — не модель Anthropic, просить нечего`);
    } else if (antIds.length === 0) {
      why.push(antModel
        ? 'anthropic: каталог ответил пустым списком — id взят из слага OpenRouter'
        : `anthropic: каталог ответил пустым списком, а флагман (${flagshipModel}) — не модель Anthropic; просить нечего`);
    }
    // Потолок ДО запроса: эта ступень самая дорогая в платформе, и включается
    // она автоматически — когда ломается дешёвая. Ровно так 19.09 и кончился
    // баланс (см. шапку anthropicDirectBudgetState).
    const gate = anthropicDirectGate();
    if (antModel && !gate.allowed) {
      why.push(`anthropic(${antModel}): ${gate.reason}`);
      console.error(`[ai-decision] прямой Anthropic не вызван: ${gate.reason}`);
    }
    if (antModel && gate.allowed) try {
      const sys = payload.find(m => m.role === 'system');
      const turns = payload.filter(m => m.role === 'user' || m.role === 'assistant');
      if (turns.length) {
        const res = await relayFetchWithRetry(`${ANTHROPIC_BASE}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': antKey, 'anthropic-version': '2023-06-01' },
          // temperature НЕ шлём: Opus 4.8 и новее через прямой Anthropic API
          // его депрекейтнули (HTTP 400 "temperature is deprecated").
          body: JSON.stringify({
            model: antModel, max_tokens: 2000,
            ...(sys ? { system: sys.content } : {}),
            messages: turns,
          }),
        }, { timeoutMs: 45_000, label: `evo-decision-anthropic:${antModel}` });
        if (res.ok) {
          const data = await res.json() as {
            content?: Array<{ text?: string }>;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          // Берём ПЕРВЫЙ ТЕКСТОВЫЙ блок, а не content[0]: у моделей с
          // расширенным размышлением (Opus и новее) первым в массиве идёт блок
          // thinking, у которого поля `text` нет вовсе. Прежняя строка
          // `content[0].text` на таком ответе давала undefined — решатель
          // рапортовал «anthropic: пустой ответ» при живом ключе и успешном
          // HTTP 200. Именно это и видел владелец в отчёте Evo.
          const text = (data?.content ?? [])
            .map(b => (typeof b?.text === 'string' ? b.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
          if (text) {
            logLLMUsage(`anthropic:${antModel}`, {
              prompt_tokens: data.usage?.input_tokens,
              completion_tokens: data.usage?.output_tokens,
            });
            // Счёт ведём ПОСЛЕ ответа и по своим же ценам — тем самым
            // источником, которым считаются книги (resolveCostUsd), чтобы
            // потолок и отчёт не расходились в числах.
            await chargeAnthropicDirect(
              `anthropic:${antModel}`,
              data.usage?.input_tokens ?? 0,
              data.usage?.output_tokens ?? 0,
            );
            return { text, model: `anthropic:${antModel}`, provenance: why.slice() };
          }
          why.push(`anthropic(${antModel}): пустой ответ`);
        } else {
          // Имя модели — в причине: без него «HTTP 400» не отличить от
          // отказа по ключу, и именно на этом разбор простоял четверо суток.
          why.push(`anthropic(${antModel}): HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
        }
      }
    } catch (e) { why.push(`anthropic: ${(e as Error).message.slice(0, 100)}`); }
  }

  // 0в) xAI Grok — флагман, достижимый из РФ НАПРЯМУЮ, без релея и без шлюза.
  //
  //     Решение владельца 04.09 («добавь 4.6, сильная модель») расширяет
  //     правило 04.08 «решатель дипсик либо опус»: сток стало два, и второй
  //     не слабое звено в хвосте, а флагман. Именно от слабого хвоста то
  //     правило и защищало — молчание честнее тихой подмены качества, — так
  //     что запрет на слабых остаётся в силе, а Grok под него не подходит.
  //
  //     Стоит ВЫШЕ DeepSeek намеренно, и это дороже по времени: замер 04.09
  //     (ai-debug run 10, с прода) — grok-4.6 отвечает за 43 с против 0,3 с у
  //     DeepSeek. У решателя это правильный обмен, и он записан в шапке
  //     функции: здесь качество важнее latency, потому что зовёт крон, а не
  //     человек. На живом пути Кузьмича обмен обратный — там xAI идёт быстрой
  //     моделью во втором эшелоне водопада.
  //
  //     Модель не прибита к id: resolveXaiModel('strong') выбирает сильнейшую
  //     из каталога провайдера (§8). Override — XAI_MODEL.
  const xaiKey = getXaiKey();
  if (!xaiKey) why.push('xai: ключа нет');
  if (xaiKey) {
    const xaiModel = await resolveXaiModel('strong');
    if (!xaiModel) {
      why.push(`xai: модель не разрешена — ${xaiResolveProblem() ?? 'каталог недоступен'}`);
    } else {
      try {
        const res = await fetchWithRetry('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${xaiKey}` },
          body: JSON.stringify({ model: xaiModel, temperature: 0.3, max_tokens: 2000, messages: payload }),
        }, { timeoutMs: 90_000, maxRetries: 0, label: `evo-decision-xai:${xaiModel}` });
        if (res.ok) {
          const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: ProviderUsage };
          const text = data?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            logLLMUsage(answeredModel(xaiModel, data), data.usage);
            return { text, model: `xai:${xaiModel}`, provenance: why.slice() };
          }
          why.push(`xai(${xaiModel}): пустой ответ — ${describeEmptyCompletion(data)}`);
        } else {
          why.push(`xai(${xaiModel}): HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
        }
      } catch (e) { why.push(`xai(${xaiModel}): ${(e as Error).message.slice(0, 100)}`); }
    }
  }

  // 1) DeepSeek (модель определяется сама) — прямой api.deepseek.com, доступен из РФ
  const dsKey = getDeepSeekKey();
  if (!dsKey) why.push('deepseek: ключа нет');
  if (dsKey) {
    // DeepSeek тасует линейку (v3 → v4-pro/v4-flash), и сильнейшая по резолву
    // модель может молчать: deepseek-v4-pro отдал 200 с пустым body (полевые
    // прогоны 02–03.08), а «вечная» страховка deepseek-chat к тому моменту уже
    // получала 400 «not supported». Значит перебирать надо не два хардкода, а
    // ВСЕ пригодные модели, которые провайдер реально отдаёт в /models —
    // сильнейшая первой (§8: без привязки к id). Пустой ответ или model-specific
    // ошибка (400/404) → следующая модель; account-wide (401/402/403/429) →
    // выходим, другая модель не спасёт.
    const primary = await resolveDecisionModel('deepseek');
    const eligible = classifyModels(await getProviderModelIds('deepseek'))
      .filter(m => m.eligible).map(m => m.id);
    const candidates = [...new Set([primary, ...eligible, 'deepseek-chat'])];
    for (const model of candidates) {
      try {
        /**
         * Решатель — не чат: здесь думать и надо, потолок покрывает
         * размышление вместе с ответом (см. deepThinkingBudget).
         *
         * Но у сильнейшей модели размышление на длинной находке съедает
         * потолок целиком, и ответа не остаётся. Замер судьи (#1428):
         * reasoning_content 10251 и 11976 знаков при бюджете 3000 токенов —
         * в пятнадцать-двадцать раз больше тех 575-686 знаков, по которым
         * надбавка +1500 и калибровалась.
         *
         * ЦЕНА БЫЛА НЕ «одна находка не разобрана». Пустой ответ уводил на
         * СЛЕДУЮЩЕГО кандидата — то есть на более слабую модель. Значит на
         * самых длинных, самых трудных находках вердикт выносил слабейший,
         * а в отчёте это выглядело всего лишь строкой в таблице «модель —
         * вердиктов». Инверсия качества, невидимая по построению.
         *
         * Поэтому повтор — ТОЙ ЖЕ моделью и без размышления, а не переход к
         * следующей. Рычаг выбран измерением: `thinking: disabled` лечит
         * (04.09, run 7), больший потолок — нет (12.09: прибавка 2200
         * токенов сдвинула обрыв меньше чем на 100 знаков, вся ушла в
         * дополнительное размышление). Весь бюджет достаётся ответу, надбавка
         * на размышление не нужна.
         */
        const ask = (think: boolean) => fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dsKey}` },
          body: JSON.stringify({
            model, temperature: 0.3,
            max_tokens: think ? deepThinkingBudget(1500) : 1500,
            messages: payload, ...deepseekThinking(think ? 'deep' : 'fast'),
          }),
        }, { timeoutMs: 90_000, label: `evo-decision:${model}${think ? '' : ':no-think'}` });

        let res = await ask(true);
        if (res.ok) {
          const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: ProviderUsage };
          const text = data?.choices?.[0]?.message?.content;
          if (text?.trim()) { logLLMUsage(answeredModel(model, data), data.usage); return { text, model: answeredModel(model, data), provenance: why.slice() }; }

          // Размышление съело ответ — единственный случай, который лечится
          // повтором. Прочая немота (фильтр, error под 200, пустой choices)
          // от выключенного размышления не проходит, и повторять её значило бы
          // платить вторым запросом за то же молчание.
          if (reasoningAteTheAnswer(data)) {
            why.push(`deepseek(${model}): размышление съело ответ — ${describeEmptyCompletion(data)}; повтор без размышления`);
            res = await ask(false);
            if (res.ok) {
              const retry = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: ProviderUsage };
              const retryText = retry?.choices?.[0]?.message?.content;
              if (retryText?.trim()) {
                logLLMUsage(answeredModel(model, retry), retry.usage);
                return { text: retryText, model: answeredModel(model, retry), provenance: why.slice() };
              }
              why.push(`deepseek(${model}) без размышления: пустой ответ — ${describeEmptyCompletion(retry)}`);
            } else {
              why.push(`deepseek(${model}) без размышления: HTTP ${res.status}`);
            }
            continue;
          }

          why.push(`deepseek(${model}): пустой ответ — ${describeEmptyCompletion(data)}`);
          continue; // пустой body — беда конкретной модели, пробуем следующую
        }
        const bodyText = (await res.text().catch(() => '')).slice(0, 140);
        why.push(`deepseek(${model}): HTTP ${res.status} ${bodyText}`);
        // 401/402/403/429 — ключ/баланс/лимит: провайдер-wide, вторая модель не
        // спасёт. 400/404 (устаревший/неизвестный id, «not supported») — model-
        // specific: пробуем следующую. «maximum context length» (400) — ревью не
        // влезло, тут другая модель тоже не поможет, но это редкий частный случай.
        if ([401, 402, 403, 429].includes(res.status) || /context length|too long|max.*tokens/i.test(bodyText)) break;
      } catch (e) { why.push(`deepseek: ${(e as Error).message.slice(0, 100)}`); break; }
    }
  }

  // Qwen и Kimi в решателе БОЛЬШЕ НЕ УЧАСТВУЮТ (решение владельца 04.08:
  // «решатель дипсик либо опус»).
  //
  // Почему это правильно, а не просто короче. Решатель отвечает за находки
  // эволюции, которые потом идут в GitHub Issues и в работу. Слабое звено в
  // хвосте waterfall опаснее его отсутствия: когда сильные модели молчат, ответ
  // всё равно приходил — но от модели послабее, и отличить его было нечем,
  // кроме поля model. Молчание честнее тихой подмены качества.
  //
  // Qwen и Kimi остаются доступны для ДРУГИХ задач (callAIWaterfall/callAIFast,
  // зрение) — здесь убран только путь принятия решений.
  //
  // xAI Grok (ступень 0в) этому не противоречит: правило запрещало СЛАБОЕ
  // звено в хвосте, а не второй сток вообще. Grok-4.6 — флагман, и внесён он
  // решением владельца 04.09, а не как «ещё один провайдер на всякий случай».

  return { text: null, model: null, error: why.join(' | ').slice(0, 600) || 'причина не зафиксирована', provenance: why.slice() };
}

// Диагностика ПРИЧИНЫ, почему callQwen молчит: реальный POST в
// /chat/completions с моделью ЦИКЛА ИНСТРУМЕНТОВ. 401/403 = ключ, 404 = не та
// модель, conn/timeout = база или RF-блок хоста.
//
// С 25.09 проба идёт той же цепочкой, что живой путь: настроенная модель, а
// если её бесплатная квота кончилась — её снимок (lib/ai/qwen-free-quota).
// Иначе health будил «Qwen не отвечает» про модель, в которую живой путь уже
// не ходит. Замещённые — в `exhausted`, чтобы подмена была видна.
export async function probeQwenKeyStatus(): Promise<{
  key_set: boolean;
  base: string;
  model: string;
  http_status: number | null;
  detail: string;
  exhausted: string[];
}> {
  const { apiKey, base, model: configured } = getQwenConfig();
  if (!apiKey) return { key_set: false, base, model: configured, http_status: null, detail: 'ключ не задан', exhausted: [] };

  let last = { model: configured, http_status: null as number | null, detail: 'квота кончилась у всех замен' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = await nextQwenToolsModel(configured);
    if (!model) break;
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.text()).slice(0, 300);
      last = { model, http_status: res.status, detail: body };
      if (!isFreeQuotaExhausted(res.status, body)) break;
      markFreeQuotaExhausted(model);
    } catch (e) {
      last = { model, http_status: null, detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}` };
      break;
    }
  }
  return { key_set: true, base, ...last, exhausted: exhaustedModels() };
}

/**
 * Чем именно DashScope отказал. 403 у него — не всегда «ключ плохой».
 *
 * 24.09 health прислал «ключ отвергнут в ОБОИХ регионах — перевыпустить», а
 * часом раньше проба с прода тем же ключом разобрала снимок на qwen-vl-max.
 * Ключ был жив: 403 шёл от КВОТЫ одной модели (qwen-plus, которой health
 * шлёт ping) — у DashScope квоты раздельные по моделям, а переключатель
 * «Free tier only» не даёт тратить пополненный баланс (§8 CLAUDE.md,
 * AllocationQuota.FreeTierOnly). Совет «перевыпустить» в этом случае
 * бесполезен, лечится снятием переключателя.
 *
 * Поэтому исходов четыре, а не один: квота (ключ принят), неоплата, неверный
 * ключ и «отказал, а чем — по телу не понять». Последний не сводится ни к
 * одному из первых: угадывание здесь уже стоило ложной тревоги.
 */
export type QwenRefusal = 'quota' | 'arrears' | 'invalid_key' | 'refused';

export function qwenRefusalKind(status: number | null, body: string): QwenRefusal | null {
  if (status !== 401 && status !== 403) return null;
  if (/AllocationQuota|FreeTierOnly|free\s*tier|quota/i.test(body)) return 'quota';
  if (/Arrearage|overdue|arrears/i.test(body)) return 'arrears';
  if (status === 401 || /InvalidApiKey|Incorrect API key|invalid.{0,20}api.?key/i.test(body)) return 'invalid_key';
  return 'refused';
}

/** Код ошибки из тела DashScope — коротко, для текста алерта. */
function qwenErrorCode(body: string): string {
  const m = body.match(/"code"\s*:\s*"([^"]{1,60})"/);
  return m ? m[1] : body.replace(/\s+/g, ' ').slice(0, 80);
}

/** Два независимых шлюза DashScope. Ключ одного даёт 401 в другом. */
export const QWEN_BASE_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const QWEN_BASE_CN   = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * Где ключ Qwen вообще принимают.
 *
 * Повод: DASHSCOPE_API_KEY отдавал `401 Incorrect API key`, и дальше начиналось
 * гадание. У DashScope ДВА независимых региона — международный (ключи из консоли
 * alibabacloud.com) и китайский (aliyun.com / Bailian). Ключ, выпущенный в
 * одном, в другом отвечает ровно этой 401: он не «неверный», он «не отсюда».
 * Прежняя проба стучалась только в настроенный шлюз и различить эти случаи не
 * могла — оставалась подсказка «проверь регион консоли».
 *
 * Здесь пробуем ОБА и возвращаем ответ вместо подсказки: ключ живой и вот где,
 * либо мёртв в обоих — тогда перевыпуск.
 */
export async function probeQwenRegions(): Promise<{
  key_set: boolean;
  model: string;
  configured_base: string;
  results: Array<{ region: 'intl' | 'cn'; base: string; http_status: number | null; detail: string }>;
  working_base: string | null;
  verdict: string;
}> {
  const { apiKey, base: configured, model } = getQwenConfig();
  if (!apiKey) {
    return {
      key_set: false, model, configured_base: configured, results: [],
      working_base: null, verdict: 'DASHSCOPE_API_KEY не задан на Timeweb',
    };
  }

  const targets: Array<{ region: 'intl' | 'cn'; base: string }> = [
    { region: 'intl', base: QWEN_BASE_INTL },
    { region: 'cn',   base: QWEN_BASE_CN },
  ];

  const results = await Promise.all(targets.map(async (t) => {
    try {
      const res = await fetch(`${t.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ...t, http_status: res.status, detail: (await res.text()).slice(0, 200) };
    } catch (e) {
      return { ...t, http_status: null, detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}` };
    }
  }));

  const ok = results.find(r => r.http_status !== null && r.http_status < 400);
  if (ok) {
    const verdict = ok.base === configured
      ? `ключ рабочий на ${ok.region} — шлюз настроен верно`
      : `ключ рабочий на ${ok.region}, а настроен другой шлюз — поставь QWEN_BASE_URL=${ok.base}`;
    return { key_set: true, model, configured_base: configured, results, working_base: ok.base, verdict };
  }

  // Ключ ПРИНЯТ, но у модели кончилась квота — это не «отвергнут». Проверка
  // первой: квоту шлюз отдаёт тем же 403, и без неё вердикт ниже звал бы
  // перевыпускать живой ключ (24.09).
  const quota = results.find(r => qwenRefusalKind(r.http_status, r.detail) === 'quota');
  if (quota) {
    return {
      key_set: true, model, configured_base: configured, results, working_base: quota.base,
      verdict: `ключ принят на ${quota.region}, но у модели ${model} нет квоты (${qwenErrorCode(quota.detail)}) — `
        + 'снять «Free tier only» в Model Studio → Model Usage → Free Quota; перевыпуск ключа не поможет',
    };
  }
  const arrears = results.find(r => qwenRefusalKind(r.http_status, r.detail) === 'arrears');
  if (arrears) {
    return {
      key_set: true, model, configured_base: configured, results, working_base: arrears.base,
      verdict: `ключ принят на ${arrears.region}, но счёт не оплачен (${qwenErrorCode(arrears.detail)}) — пополнить баланс`,
    };
  }

  // Ни один не принял. Различаем «ключ отвергнут» и «до шлюза не достучались»:
  // первое лечится перевыпуском, второе — сетью, и путать их дорого.
  const rejected = results.filter(r => r.http_status === 401 || r.http_status === 403);
  if (rejected.length === results.length) {
    return {
      key_set: true, model, configured_base: configured, results, working_base: null,
      verdict: 'ключ отвергнут в ОБОИХ регионах — перевыпустить в консоли Model Studio'
        + ` (${results.map(r => `${r.region}:${r.http_status} ${qwenErrorCode(r.detail)}`).join('; ')})`,
    };
  }
  const unreachable = results.filter(r => r.http_status === null).map(r => r.region);
  return {
    key_set: true, model, configured_base: configured, results, working_base: null,
    verdict: unreachable.length
      ? `шлюзы недоступны (${unreachable.join(', ')}) — сеть или блокировка, ключ ни при чём`
      : `ни один шлюз не принял: ${results.map(r => `${r.region}:${r.http_status}`).join(', ')}`,
  };
}

/**
 * Диагностика DeepSeek — та же форма, что у probeQwenKeyStatus /
 * probeOpenRouterKeyStatus.
 *
 * Зачем: DeepSeek — первичный решатель эволюции (CLAUDE.md §8), но в
 * cron/health он единственный проверялся обезличенным probeAI (true/false).
 * Алерт «WARN: DeepSeek недоступен» приходил без причины: не отличить «ключ не
 * задан» от «401/402 по балансу» и от «сеть/таймаут». У соседей по водопаду
 * диагностика была, у главного — нет.
 */
export async function probeDeepSeekKeyStatus(): Promise<{
  key_set: boolean;
  http_status: number | null;
  detail: string;
}> {
  const apiKey = getDeepSeekKey();
  if (!apiKey) return { key_set: false, http_status: null, detail: 'ключ не задан' };

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: await resolveDeepSeekModel(), max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.text()).slice(0, 300);
    return { key_set: true, http_status: res.status, detail: body };
  } catch (e) {
    return {
      key_set: true,
      http_status: null,
      detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`,
    };
  }
}

/**
 * Диагностика Anthropic — та же форма, что у probeDeepSeekKeyStatus, плюс
 * хост пути: ANTHROPIC_BASE бывает релеем (воркер Cloudflare), бывает прямым.
 *
 * Зачем (24.09): владелец переслал «Anthropic недоступен с прода — и
 * напрямую, и через OpenRouter» — единственное предупреждение сводки без
 * причины. У соседей по водопаду диагностика есть, и разница не косметика:
 * замер 03.09 (anthropic-path-probe) показал, что путь через релей открыт,
 * а отказывает баланс ключа («credit balance is too low»), — то есть чинится
 * пополнением, а не сетью и не ключом. Одно слово «недоступен» этих троих не
 * различает.
 *
 * Модель — та же, что у callAnthropic: проба спрашивает то, что платформа
 * реально зовёт. max_tokens 1 — цена пробы ничтожна, а при нулевом балансе
 * запрос не тарифицируется вовсе.
 */
export async function probeAnthropicKeyStatus(): Promise<{
  key_set: boolean;
  route_host: string;
  http_status: number | null;
  detail: string;
}> {
  const apiKey = getAnthropicKey();
  let route_host = ANTHROPIC_BASE;
  try { route_host = new URL(ANTHROPIC_BASE).host; } catch { /* адрес битый — покажем как есть */ }
  if (!apiKey) return { key_set: false, route_host, http_status: null, detail: 'ключ не задан' };
  try {
    const res = await relayFetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.text()).slice(0, 300);
    return { key_set: true, route_host, http_status: res.status, detail: body };
  } catch (e) {
    return {
      key_set: true,
      route_host,
      http_status: null,
      detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`,
    };
  }
}

/**
 * Причина отказа Anthropic — человеком, в текст алерта.
 *
 * Форма ответа решает, ДОШЛИ ли мы до Anthropic (тот же признак, что у
 * anthropic-path-probe 03.09): тело `{"type":"error",...}` — это ответ самого
 * Anthropic, и путь открыт; 403 без такого тела — путь закрыт по дороге.
 * Сообщение Anthropic цитируется: у него своя точная формулировка, и
 * пересказ потерял бы, что именно чинить.
 */
export function explainAnthropicFailure(probe: {
  key_set: boolean;
  route_host: string;
  http_status: number | null;
  detail: string;
}): string {
  if (!probe.key_set) return 'ANTHROPIC_API_KEY не задан на Timeweb';
  if (diagnosticSaysAlive(probe.http_status)) {
    return `ответил HTTP ${probe.http_status} через ${probe.route_host} — провайдер жив, отказа нет`;
  }
  if (probe.http_status === null) return `через ${probe.route_host}: ${probe.detail}`;
  let message: string | null = null;
  let fromAnthropic = false;
  try {
    const j: unknown = JSON.parse(probe.detail);
    if (j && typeof j === 'object' && (j as { type?: unknown }).type === 'error') {
      fromAnthropic = true;
      const err = (j as { error?: { message?: unknown } }).error;
      if (typeof err?.message === 'string') message = err.message;
    }
  } catch { /* не JSON — значит отвечал не Anthropic (обрезка тела тоже сюда) */ }
  if (!fromAnthropic && /"type"\s*:\s*"error"/.test(probe.detail)) fromAnthropic = true;
  if (fromAnthropic && /credit balance/i.test(probe.detail)) {
    return `путь через ${probe.route_host} открыт, но на балансе ключа нет денег (HTTP ${probe.http_status}: «credit balance is too low») — чинится пополнением в console.anthropic.com, не сетью и не ключом`;
  }
  if (fromAnthropic && probe.http_status === 401) return `ключ отвергнут самим Anthropic (401) через ${probe.route_host}`;
  if (probe.http_status === 403 && !fromAnthropic) {
    return `путь через ${probe.route_host} закрыт до Anthropic (403, ответил не Anthropic): ${probe.detail.slice(0, 100)}`;
  }
  const said = message ?? probe.detail.slice(0, 120);
  return `HTTP ${probe.http_status} через ${probe.route_host}${fromAnthropic ? ' (ответ самого Anthropic)' : ''}: ${said}`;
}

/**
 * Отказ Anthropic с прода — то положение, которое владелец принял, или новость?
 *
 * Решение владельца 24.09 («Anthropic с прода геоблок ты забыл», «мне
 * надоело»): с прода Anthropic не рабочий путь, и будить им не надо. Всё,
 * чему нужен флагман, считается на раннере GitHub — решатель эволюции идёт
 * на Opus 5.5 через OpenRouter оттуда. Ровно то же решение, что 08.09 для
 * OpenRouter (isAcceptedOpenRouterGeoBlock).
 *
 * Измерено (anthropic-path-probe, прогоны 10-13): прямой адрес — 403
 * «Request not allowed», гео-блок; через релей и AI Gateway доходим до
 * самого Anthropic и получаем 401 «API key is invalid». Оба — отказ в
 * ДОСТУПЕ, и оба принимаются. Сеть не дошла, 5xx, 429, баланс, иной ответ и
 * несобранная диагностика — новость: они говорят, что сломалось что-то ещё
 * (релей, общий для OpenRouter; сам Anthropic), и будят.
 */
export function isAcceptedAnthropicFromProd(probe: {
  key_set: boolean;
  http_status: number | null;
} | null): boolean {
  if (!probe || !probe.key_set) return false;
  return probe.http_status === 401 || probe.http_status === 403;
}

/**
 * Диагностика ответила успехом — провайдер ЖИВ, чем бы ни кончилась быстрая
 * проба здоровья.
 *
 * ── Случай 20.09 ───────────────────────────────────────────────────────────
 *
 * Владелец переслал CRIT «Все AI-провайдеры недоступны», в теле которого
 * стояло: «DeepSeek: HTTP 200: {"id":"...","object":"chat.completion",...}».
 * Заголовок опровергался собственным телом.
 *
 * Механизм: быстрая проба даёт провайдеру 8 секунд и возвращает false по
 * таймауту — неотличимо от настоящего отказа. Диагностика того же провайдера
 * ходит отдельно с бюджетом 10 секунд и успела. Дальше `anyOk` считался
 * только по быстрым пробам, диагностики в нём не участвовали, — и пять
 * таймаутов стали «недоступны все».
 *
 * Это §4.0: «не смог за 8 секунд» и «недоступен» — разные исходы, а у пробы
 * их было два вместо трёх. Цена — ложная тревога высшего уровня, которая
 * заслоняет настоящие: в том же письме DeepSeek стал отвечать дольше восьми
 * секунд против 0,3 замеренных 04.09, и эта новость утонула.
 */
export function diagnosticSaysAlive(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/** Человекочитаемая причина отказа DeepSeek для алерта. */
export function explainDeepSeekFailure(probe: {
  key_set: boolean;
  http_status: number | null;
  detail: string;
}): string {
  if (!probe.key_set) return 'DEEPSEEK_API_KEY не задан на Timeweb';
  // Успех в «объяснении отказа» — не отказ. Без этой ветки 200 доезжал до
  // последней строки и форматировался как причина недоступности (20.09).
  if (diagnosticSaysAlive(probe.http_status)) {
    return `ответил HTTP ${probe.http_status} — провайдер жив, отказа нет`;
  }
  if (probe.http_status === 401 || probe.http_status === 403) return 'ключ отвергнут (401/403)';
  if (probe.http_status === 402) return 'нет средств на балансе (402)';
  if (probe.http_status === 429) return 'лимит запросов (429)';
  if (probe.http_status === null) return probe.detail;
  if (probe.http_status >= 500) return `сбой на стороне DeepSeek (${probe.http_status})`;
  return `HTTP ${probe.http_status}: ${probe.detail.slice(0, 120)}`;
}

/**
 * Человекочитаемая причина отказа OpenRouter для алерта.
 *
 * До 24.08 предупреждение было безусловным и однословным: «OpenRouter
 * недоступен». Соседи так не делают — у DeepSeek и Anthropic оно молчит, если
 * ключ просто не задан («не настроен» не равно «сбой»). Одно слово покрывало
 * три разных случая, и цена этого была не теоретической: задача в бэклоге
 * называлась «ключ OpenRouter пропал с прода», хотя ключ был на месте — 73
 * символа, верный префикс, без пробелов. Правили бы ключ, а чинить надо
 * другое.
 *
 * Разделение направлений ремонта берётся из уже собираемой диагностики:
 *   ключа нет            → завести переменную на Timeweb;
 *   форма ключа битая    → вставили не то или с переводом строки;
 *   релей и прямой путь
 *   ответили ОДИНАКОВО   → режет край сети по нашему адресу, и релей его не
 *                          прячет — лечится сменой площадки релея, не ключом;
 *   ответы разные        → режет на выходе именно к релею;
 *   прочее               → код и начало тела, без домыслов.
 */
export function explainOpenRouterFailure(probe: {
  key_source: 'OR_API_KEY' | 'OPENROUTER_API_KEY' | null;
  route: 'relay' | 'direct';
  route_host: string;
  http_status: number | null;
  detail: string;
  direct_status: number | null;
  direct_detail: string | null;
  /** null — форму не измерили. Это «не знаю», а не «форма в порядке». */
  key_shape: { key_len: number; key_prefix_ok: boolean; key_had_outer_space: boolean; key_has_inner_space: boolean } | null;
}): string {
  if (!probe.key_source) return 'ключ не задан на Timeweb (OPENROUTER_API_KEY)';
  const sh = probe.key_shape;
  // Форму не измерили — говорим об этом, а не молчим. Молчание здесь читалось
  // бы как «с ключом всё хорошо», то есть как ответ, которого у нас нет.
  if (!sh) return 'ключ задан, но форму проверить не удалось — судить о нём нечем';
  if (!sh.key_prefix_ok || sh.key_had_outer_space || sh.key_has_inner_space) {
    return `ключ задан, но форма подозрительна (длина ${sh.key_len}` +
      `${sh.key_prefix_ok ? '' : ', префикс не тот'}` +
      `${sh.key_had_outer_space ? ', пробелы по краям' : ''}` +
      `${sh.key_has_inner_space ? ', пробел внутри' : ''})`;
  }
  const sameAsDirect =
    probe.route === 'relay' &&
    probe.direct_status !== null &&
    probe.direct_status === probe.http_status &&
    (probe.direct_detail ?? '') === probe.detail;
  if (sameAsDirect) {
    return `ключ на месте и цел; ${probe.http_status} и через релей (${probe.route_host}), ` +
      'и напрямую — ответы совпали дословно. Значит режет край сети по нашему адресу, ' +
      'релей его не прячет: менять надо площадку релея, а не ключ';
  }
  if (probe.http_status === 401 || probe.http_status === 403) {
    return `ключ на месте и цел, но путь через ${probe.route_host} отвергнут (${probe.http_status}): ` +
      `${probe.detail.slice(0, 120)}`;
  }
  if (probe.http_status === null) return probe.detail;
  return `HTTP ${probe.http_status} через ${probe.route_host}: ${probe.detail.slice(0, 120)}`;
}

/**
 * Это ТОТ САМЫЙ отказ, который владелец принял, — или новость?
 *
 * Принято ровно одно положение дел: OpenRouter закрыт для прода по региону
 * (403), ключ при этом на месте и цел, а работа, которой OpenRouter нужен,
 * решением владельца 07.09 переехала на раннер GitHub, где он достижим.
 * Повторять о таком каждые полчаса — учить пролистывать сводку.
 *
 * Всё остальное новостью остаётся и обязано будить: 401 — ключ отвергнут,
 * ключа нет вовсе, форма ключа испорчена, сеть не дошла (`http_status: null`),
 * любой другой код. Признак принятого — только 403 при целом ключе, и
 * специально НЕ «ключ на месте, что-то не работает»: широкий предикат здесь
 * означал бы выключенную сигнализацию, а не убранный шум.
 *
 * Форму не измерили (`key_shape === null`) — это «не знаю» (§4.0), и оно не
 * принимается: судить о принятости нечем, значит будим.
 */
export function isAcceptedOpenRouterGeoBlock(probe: {
  key_source: 'OR_API_KEY' | 'OPENROUTER_API_KEY' | null;
  http_status: number | null;
  key_shape: { key_len: number; key_prefix_ok: boolean; key_had_outer_space: boolean; key_has_inner_space: boolean } | null;
} | null): boolean {
  if (!probe || !probe.key_source) return false;
  const sh = probe.key_shape;
  if (!sh) return false;
  if (!sh.key_prefix_ok || sh.key_had_outer_space || sh.key_has_inner_space) return false;
  return probe.http_status === 403;
}

/**
 * Причина падения Qwen — человеком, в текст алерта.
 *
 * Диагностика qwen_key_diag лежала в JSON health с самого начала, но в
 * Telegram уходило только «Qwen недоступен (проверь RF-доступность/базу/
 * модель)» — то есть перечень ГИПОТЕЗ вместо ответа, при том что ответ уже
 * был собран. Ровно эта разница у DeepSeek 26.07 сократила диагностику смены
 * линейки с гадания «ключ или баланс?» до одного взгляда на алерт.
 *
 * База и модель включены в текст: у Qwen два региональных шлюза
 * (dashscope / dashscope-intl), и ошибка «ключ не от этого региона»
 * неотличима от прочих 401 без указания, КУДА ходили.
 */
export function explainQwenFailure(probe: {
  key_set: boolean;
  base: string;
  model: string;
  http_status: number | null;
  detail: string;
}): string {
  const where = `${probe.base.includes('-intl') ? 'intl' : 'cn'}/${probe.model}`;
  if (!probe.key_set) return 'DASHSCOPE_API_KEY не задан на Timeweb';
  const kind = qwenRefusalKind(probe.http_status, probe.detail);
  if (kind === 'quota') {
    return `ключ принят, но у модели нет квоты (${probe.http_status} ${qwenErrorCode(probe.detail)}, ${where}) — снять «Free tier only» в Model Studio`;
  }
  if (kind === 'arrears') return `счёт не оплачен (${probe.http_status} ${qwenErrorCode(probe.detail)}, ${where})`;
  if (kind !== null) {
    return `ключ отвергнут (${probe.http_status} ${qwenErrorCode(probe.detail)}, шлюз ${where}) — проверь регион консоли`;
  }
  if (probe.http_status === 402) return `нет средств на балансе (402, ${where})`;
  if (probe.http_status === 404) return `модель не найдена (404, ${where}) — линейка сменилась?`;
  if (probe.http_status === 429) return `лимит запросов (429, ${where})`;
  if (probe.http_status === null) return `${probe.detail} (шлюз ${where})`;
  if (probe.http_status >= 500) return `сбой на стороне Qwen (${probe.http_status})`;
  return `HTTP ${probe.http_status} (${where}): ${probe.detail.slice(0, 120)}`;
}

// ── GLM 5.1 (ZhipuAI direct API — bigmodel.cn) ────────────────
// ZhipuAI OpenAI-compatible endpoint. Env: GLM_API_KEY
export async function callGLM(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getGLMKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'glm-5.1',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── NVIDIA NIM (OpenAI-compatible, 100+ моделей бесплатно) ────
// Docs: https://build.nvidia.com — Free tier, OpenAI API format
// Модель: meta/llama-3.3-70b-instruct (сильная, быстрая, бесплатно)
// Env: NVIDIA_API_KEY
export async function callNvidia(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getNvidiaKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Groq (OpenAI-compatible, Llama 3.3-70B бесплатно, очень быстрый LPU) ──
// Docs: https://console.groq.com — Free tier, OpenAI API format
// Env: GROQ_API_KEY. Инертна без ключа. GEO: US — проверить достижимость с РФ-IP.
const GROQ_MODEL = 'llama-3.3-70b-versatile';
export async function callGroq(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getGroqKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 15_000, label: 'groq' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(answeredModel(GROQ_MODEL, data), data.usage);
      return text.trim();
    }
    return null;
  } catch { return null; }
}

// ── Cerebras (OpenAI-compatible, Llama 3.3-70B бесплатно, экстремально быстрый) ──
// Docs: https://cloud.cerebras.ai — Free tier, OpenAI API format
// Env: CEREBRAS_API_KEY. Инертна без ключа. GEO: US — проверить достижимость.
const CEREBRAS_MODEL = 'llama-3.3-70b';
export async function callCerebras(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getCerebrasKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 15_000, label: 'cerebras' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(answeredModel(CEREBRAS_MODEL, data), data.usage);
      return text.trim();
    }
    return null;
  } catch { return null; }
}

// ── Mistral La Plateforme (OpenAI-compatible, mistral-small бесплатно) ──
// Docs: https://console.mistral.ai — Free tier (opt-in), OpenAI API format
// Env: MISTRAL_API_KEY. Инертна без ключа. GEO: EU — проверить достижимость.
const MISTRAL_MODEL = 'mistral-small-latest';
export async function callMistral(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getMistralKey();
  if (!apiKey) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetchWithRetry('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
    }, { timeoutMs: 15_000, label: 'mistral' });
    if (!res.ok) return null;
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (text?.trim()) {
      logLLMUsage(answeredModel(MISTRAL_MODEL, data), data.usage);
      return text.trim();
    }
    return null;
  } catch { return null; }
}

// ── MiniMax 2.5 (direct API) ─────────────────────────────────
export async function callMiniMax(messages: ChatMessage[]): Promise<string | null> {
  const keys = getMiniMaxKey();
  if (!keys) return null;

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch(
      `https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${keys.groupId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.apiKey}`,
        },
        body: JSON.stringify({
          model: 'MiniMax-Text-01',
          temperature: 0.4,
          max_tokens: 800,
          messages: payload,
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Google Gemini (direct API) ─────────────────────────────────
/**
 * Модель Gemini для прямого API — РАЗРЕШАЕТСЯ, а не прибивается (§8 CLAUDE.md).
 *
 * Замер на проде 23.08: прямой Gemini отвечал 404 «This model
 * models/gemini-2.0-flash is no longer available. Please update». Ключ был на
 * месте, провайдер был жив — умер захардкоженный id, снапшот начала 2025 года.
 * До сегодняшней пробы этого не было видно вовсе: Gemini в преполётной
 * проверке отсутствовал, а в гонке его отказ был неотличим от любого другого.
 *
 * Умолчания-запаски здесь НЕТ намеренно. Вписать сюда «наверное, сейчас
 * называется так» значит заменить один просроченный снапшот другим и снова
 * узнать об этом через полгода. Список моделей отдаёт сам Google; не отдал —
 * нога честно выбывает с причиной «модель не разрешена».
 *
 * Ручной обход — env GEMINI_MODEL.
 */
const GEMINI_MODELS_TTL_MS = 6 * 60 * 60 * 1000;
let geminiModelCache: { id: string; at: number } | null = null;

/**
 * Почему список моделей Gemini не добыт в последний раз; null — добыт.
 *
 * 04.09: Разведчик на проде записал «gemini: список моделей недоступен», а
 * ai-debug двумя минутами позже получил от того же ключа осмысленный 404 —
 * ключ жив. Что именно не так со СПИСКОМ (таймаут, HTTP-код, пустой ответ),
 * `catch { return [] }` не говорил. Теперь причина хранится и уходит в след
 * отказа и в debug-пробу.
 */
let geminiListProblem: string | null = null;
export function geminiResolveProblem(): string | null { return geminiListProblem; }

async function listGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      geminiListProblem = httpFailureReason(res.status, await res.text().catch(() => ''));
      return [];
    }
    const data = await res.json() as {
      models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
    };
    const ids = (data.models ?? [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods)
        && (m.supportedGenerationMethods as unknown[]).includes('generateContent'))
      .map((m) => (typeof m.name === 'string' ? m.name.replace(/^models\//, '') : ''))
      .filter((id) => id.length > 0);
    geminiListProblem = ids.length === 0
      ? `список пуст: ${(data.models ?? []).length} моделей, ни одной с generateContent`
      : null;
    return ids;
  } catch (e) { geminiListProblem = errorFailureReason(e); return []; }
}

/** null — модель не разрешена: списка нет и угадывать нечем. */
export async function resolveGeminiModel(): Promise<string | null> {
  const override = process.env.GEMINI_MODEL?.trim();
  if (override) return override;

  if (geminiModelCache && Date.now() - geminiModelCache.at < GEMINI_MODELS_TTL_MS) {
    return geminiModelCache.id;
  }
  const apiKey = getGeminiKey();
  if (!apiKey) return null;

  const ids = await listGeminiModels(apiKey);
  if (ids.length === 0) return null;

  // Для быстрой ноги гонки нужен flash-класс; общий отбор (без reasoner/vision/
  // embed) делает тот же pickBestModel, что и у остальных провайдеров.
  const flash = ids.filter((id) => /flash/i.test(id));
  const picked = pickBestModel(flash.length > 0 ? flash : ids);
  if (!picked) return null;

  geminiModelCache = { id: picked, at: Date.now() };
  return picked;
}

export async function callGeminiDirect(
  messages: ChatMessage[],
  opts?: FastCallOptions,
): Promise<string | null> {
  const apiKey = getGeminiKey();
  if (!apiKey) { recordAiLegFailure('gemini', 'no_key'); return null; }

  const model = await resolveGeminiModel();
  if (!model) {
    recordAiLegFailure('gemini', `модель не разрешена: список моделей недоступен (${geminiResolveProblem() ?? 'причина не записана'})`);
    return null;
  }

  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const turns = messages.filter(m => m.role !== 'system');
    const contents = turns.map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    }));

    const body: Record<string, unknown> = { contents };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }
    if (opts?.maxTokens || opts?.json) {
      body.generationConfig = {
        ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      };
    }

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: opts?.timeoutMs ?? 20_000, label: `gemini-direct:${model}` },
    );
    if (!res.ok) {
      recordAiLegFailure('gemini', httpFailureReason(res.status, await res.text().catch(() => '')));
      return null;
    }
    const data = await res.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text?.trim()) return text;
    recordAiLegFailure('gemini', 'empty');
    return null;
  } catch (e) { recordAiLegFailure('gemini', errorFailureReason(e)); return null; }
}

// ── Зрение Кузьмича ─────────────────────────────────────────────────────────
//
// Четыре ступени, и на проде живёт НЕ первая. Имя `callGeminiVision` обещало
// Gemini и ровно этим вводило в заблуждение: нативный Gemini и он же через
// OpenRouter гео-блокируются из РФ (Timeweb), так что на боевом пути фото
// разбирал Qwen-VL, а с отказом ключа DashScope — никто. Функция называется
// `callVision`, потому что называть путь по недостижимой ступени — это
// докстрока, обещающая путь, которого нет (правило 10.09).
//
// ── Почему у ступени ЧЕТЫРЕ исхода, а не два ────────────────────────────────
//
// Прежняя редакция ловила отказ каждой ступени пустым `catch {}`. Снаружи это
// давало ОДНО состояние — `null`, «фото не вижу», — под которым прятались
// четыре разных: ключа нет, провайдер ответил отказом (401/403/кончилась
// квота), сеть не дошла, ответ пришёл пустым. Человек в поле и админ на
// /hub/admin/health видели одну и ту же фразу и не могли отличить «мы не
// настроены» от «провайдер нас отверг» (§4.0: отказ не глушится).
//
// Теперь каждая ступень возвращает исход и причину словами, а `callVision`
// остаётся прежней по сигнатуре — чтобы пять вызывающих не переписывать.
export type VisionLegOutcome = 'ok' | 'refused' | 'unreachable' | 'empty' | 'skipped';

export interface VisionLeg {
  /** Ступень: gemini_native | gemini_openrouter | qwen_vl | deepseek. */
  provider: string;
  /** Какой моделью спрашивали. null — до выбора модели не дошло. */
  model: string | null;
  outcome: VisionLegOutcome;
  /** Причина словами. Секреты вычищены (stripSecrets в failure-trace). */
  detail: string | null;
  ms: number;
}

export interface VisionResult {
  text: string | null;
  legs: VisionLeg[];
}

export interface VisionOptions {
  /**
   * id модели DeepSeek со зрением. НЕ хардкодится (§8: сильнейшую берут из
   * каталога, а зрение DeepSeek каталогом не помечено никак) и не выдумывается:
   * не задан — ступень честно пропускается с причиной, а не «пробуется наугад».
   */
  deepseekModel?: string;
}

/** Имя модели: буквы, цифры, точка, дефис, подчёркивание. Слэша и двоеточия нет. */
const VISION_MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const VISION_SYSTEM_HINT =
  'Ты — эксперт по природе и достопримечательностям Камчатки. Отвечай на русском, кратко и точно. Определяй вулканы, животных, растения, локации.';

/** Тело OpenAI-совместимого запроса со снимком — одинаково у OpenRouter, Qwen и DeepSeek. */
function visionChatBody(model: string, imageBase64: string, mimeType: string, prompt: string) {
  return {
    model,
    max_tokens: 600,
    messages: [
      { role: 'system', content: VISION_SYSTEM_HINT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

/**
 * Зрение с разбором по ступеням. Ступени идут по достижимости с прода, а
 * возврат — на первом непустом ответе.
 */
export async function callVisionDetailed(
  imageBase64: string,
  mimeType: string,
  prompt: string,
  opts: VisionOptions = {},
): Promise<VisionResult> {
  const legs: VisionLeg[] = [];
  const add = (
    provider: string,
    model: string | null,
    outcome: VisionLegOutcome,
    detail: string | null,
    startedAt: number,
  ) => {
    legs.push({ provider, model, outcome, detail, ms: Date.now() - startedAt });
    if (outcome !== 'ok' && outcome !== 'skipped') recordAiLegFailure(`vision_${provider}`, detail ?? outcome);
  };

  // Ступень 1: нативный Gemini API. Модель — из /models, как у текстового пути:
  // хардкод gemini-2.0-flash отвечал 404 «no longer available» (ai-debug run 4,
  // 04.09), и распознавание молча уходило ниже.
  {
    const t = Date.now();
    const geminiKey = getGeminiKey();
    if (!geminiKey) {
      add('gemini_native', null, 'skipped', 'GEMINI_API_KEY не задан', t);
    } else {
      const visionModel = await resolveGeminiModel();
      if (!visionModel) {
        add('gemini_native', null, 'refused', 'каталог /models не дал пригодной модели', t);
      } else {
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${geminiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                system_instruction: { parts: [{ text: VISION_SYSTEM_HINT }] },
                contents: [{
                  parts: [
                    { inline_data: { mime_type: mimeType, data: imageBase64 } },
                    { text: prompt },
                  ],
                }],
                generationConfig: { maxOutputTokens: 600 },
              }),
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!res.ok) {
            add('gemini_native', visionModel, 'refused', httpFailureReason(res.status, await res.text().catch(() => '')), t);
          } else {
            const data = await res.json();
            const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text?.trim()) {
              add('gemini_native', visionModel, 'ok', null, t);
              return { text: text.trim(), legs };
            }
            add('gemini_native', visionModel, 'empty', describeEmptyCompletion(data), t);
          }
        } catch (e) {
          add('gemini_native', visionModel, 'unreachable', errorFailureReason(e), t);
        }
      }
    }
  }

  // Ступень 2: тот же Gemini через OpenRouter. С прода закрыт гео-блоком
  // (403 «Request not allowed») — оставлен для раннеров и на случай релея.
  {
    const t = Date.now();
    const apiKey = getOpenRouterKey();
    const model = 'google/gemini-2.0-flash-001';
    if (!apiKey) {
      add('gemini_openrouter', null, 'skipped', 'OPENROUTER_API_KEY не задан', t);
    } else {
      try {
        const res = await relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...openRouterAttribution(),
          },
          body: JSON.stringify(visionChatBody(model, imageBase64, mimeType, prompt)),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          add('gemini_openrouter', model, 'refused', httpFailureReason(res.status, await res.text().catch(() => '')), t);
        } else {
          const data = await res.json();
          const text: string | undefined = data?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            add('gemini_openrouter', model, 'ok', null, t);
            return { text: text.trim(), legs };
          }
          add('gemini_openrouter', model, 'empty', describeEmptyCompletion(data), t);
        }
      } catch (e) {
        add('gemini_openrouter', model, 'unreachable', errorFailureReason(e), t);
      }
    }
  }

  // Ступень 3 (RF-достижимая, БЕЗ релея): Qwen-VL через DashScope. Именно она
  // и работала на проде, пока ключ DashScope принимался; её отказ
  // (AllocationQuota.FreeTierOnly, HTTP 403) означает «квота кончилась», а не
  // «ключ не тот» — и теперь это видно в detail, а не теряется.
  {
    const t = Date.now();
    const { apiKey: qwenKey, base: qwenBase } = getQwenConfig();
    const model = process.env.QWEN_VISION_MODEL ?? 'qwen-vl-max';
    if (!qwenKey) {
      add('qwen_vl', model, 'skipped', 'ключ Qwen/DashScope не задан', t);
    } else {
      try {
        const res = await fetch(`${qwenBase}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qwenKey}` },
          body: JSON.stringify(visionChatBody(model, imageBase64, mimeType, prompt)),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          add('qwen_vl', model, 'refused', httpFailureReason(res.status, await res.text().catch(() => '')), t);
        } else {
          const data = await res.json();
          const text: string | undefined = data?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            add('qwen_vl', model, 'ok', null, t);
            return { text: text.trim(), legs };
          }
          add('qwen_vl', model, 'empty', describeEmptyCompletion(data), t);
        }
      } catch (e) {
        add('qwen_vl', model, 'unreachable', errorFailureReason(e), t);
      }
    }
  }

  // Ступень 4: DeepSeek. Заведена потому, что DeepSeek — единственный
  // провайдер, достижимый с прода БЕЗ релея и без гео-блока (он же первичный
  // в тексте), а анонс V4.1 Flash от 11.09 заявляет native visual
  // understanding. Анонс — не замер: пока имя модели не задано явно, ступень
  // ПРОПУСКАЕТСЯ с причиной, а не пробуется наугад. Замерить — пробой
  // GET /api/cron/vision-probe?deepseek_model=<id>.
  {
    const t = Date.now();
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const model = opts.deepseekModel ?? process.env.DEEPSEEK_VISION_MODEL ?? null;
    if (!apiKey) {
      add('deepseek', model, 'skipped', 'DEEPSEEK_API_KEY не задан', t);
    } else if (!model) {
      add('deepseek', null, 'skipped', 'модель со зрением не названа (DEEPSEEK_VISION_MODEL) — выдумывать id нельзя', t);
    } else if (!VISION_MODEL_ID_RE.test(model)) {
      add('deepseek', null, 'refused', 'имя модели не прошло проверку формата', t);
    } else {
      try {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          // Размышление выключено — и здесь это не экономия, а условие
          // работоспособности: max_tokens у DeepSeek считает раздумья ВМЕСТЕ с
          // ответом (замер 04.09), так что при включённом размышлении наши 600
          // токенов ушли бы в reasoning, а content вернулся бы пустым. Ровно
          // та немота, которую уже чинили в текстовом пути.
          body: JSON.stringify({
            ...visionChatBody(model, imageBase64, mimeType, prompt),
            ...deepseekThinking(),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          add('deepseek', model, 'refused', httpFailureReason(res.status, await res.text().catch(() => '')), t);
        } else {
          const data = await res.json();
          const text: string | undefined = data?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            add('deepseek', model, 'ok', null, t);
            return { text: text.trim(), legs };
          }
          add('deepseek', model, 'empty', describeEmptyCompletion(data), t);
        }
      } catch (e) {
        add('deepseek', model, 'unreachable', errorFailureReason(e), t);
      }
    }
  }

  return { text: null, legs };
}

/**
 * Зрение одной строкой — для пяти вызывающих, которым нужен только текст.
 * `null` здесь по-прежнему значит «не увидели», но ПОЧЕМУ теперь записано в
 * след отказов (`recordAiLegFailure`) и доступно пробе, а не теряется.
 */
export async function callVision(
  imageBase64: string,
  mimeType: string,
  prompt: string,
): Promise<string | null> {
  return (await callVisionDetailed(imageBase64, mimeType, prompt)).text;
}

// ── Распознавание речи ─────────────────────────────────────────
//
// Голосовые Кузьмичу шлют из Telegram и MAX (ogg/opus). До 08.09 путь был
// ОДИН — Gemini через OpenRouter, а OpenRouter с прода отвечает 403 и
// напрямую, и через релей (замер 07.09, ответы совпали дословно). То есть на
// проде не расшифровывалось НИ ОДНО голосовое, и человек в поле получал
// «Не разобрал голосовое» — фразу про свою дикцию вместо правды о том, что
// распознавание недоступно вовсе.
//
// Два исхода отказа теперь РАЗНЫЕ (§4.0). «Расслышал, но не понял» —
// свойство записи, человеку стоит повторить. «Некому было слушать» —
// свойство платформы, и повторять бессмысленно. Одна фраза на оба случая
// заставляла человека переговаривать в пустоту.
//
// Фолбэка на китайского провайдера здесь НЕТ намеренно, в отличие от зрения
// (§ callVisionDetailed, ступень 3 — Qwen-VL). Есть ли у DashScope модель
// распознавания речи, доступная нашему ключу, я не проверял, а вписать
// правдоподобный id значит завести ветку, которая выглядит запасным путём и
// не является им. Каталог спрашивается переписью `GET /api/cron/ai-models`;
// пока ответа нет, отказ хотя бы назван вслух и виден в следе.

/** Фразы, которыми модель сообщает, что не смогла обработать аудио. */
const TRANSCRIBE_FAIL_PATTERNS = [
  /не могу обработать/i, /cannot process/i, /unable to process/i,
  /audio file/i, /аудиофайл/i, /не поддерживает/i, /не поддерживаю/i,
  /i can't/i, /i cannot/i, /no audio/i, /нет аудио/i,
  /audio content/i, /audio data/i,
];

/** Модель расслышала запись, но речь неразборчива — так просит отвечать промпт. */
const TRANSCRIBE_UNINTELLIGIBLE = /^\(?неразборчиво\)?[.!]?$/i;

const TRANSCRIBE_PROMPT =
  'Это голосовое сообщение на русском языке. Транскрибируй дословно. ' +
  'Только текст без пояснений. Если неразборчиво — "(неразборчиво)".';

export type TranscribeOutcome =
  | { ok: true; text: string }
  /** Речь не разобрана — свойство записи. Повтор осмыслен. */
  | { ok: false; reason: 'unintelligible'; detail: string }
  /** Распознавать было некому — свойство платформы. Повтор бесполезен. */
  | { ok: false; reason: 'unavailable'; detail: string };

/** Что вернула ступень: текст, «неразборчиво» или отказ с причиной. */
type LegResult =
  | { kind: 'text'; text: string }
  | { kind: 'unintelligible' }
  | { kind: 'failed'; reason: string };

function readTranscript(raw: string | undefined): LegResult {
  const text = raw?.trim();
  if (!text) return { kind: 'failed', reason: 'пустой ответ' };
  if (TRANSCRIBE_UNINTELLIGIBLE.test(text)) return { kind: 'unintelligible' };
  // Отказ модели обработать аудио — не транскрипция; показывать его человеку
  // как расшифровку его же слов нельзя.
  if (TRANSCRIBE_FAIL_PATTERNS.some((p) => p.test(text))) {
    return { kind: 'failed', reason: 'модель не обработала аудио' };
  }
  return { kind: 'text', text };
}

export async function callGeminiTranscribe(
  audioBase64: string,
  mimeType: string = 'audio/ogg',
): Promise<TranscribeOutcome> {
  const failures: string[] = [];
  const note = (leg: string, reason: string): void => {
    failures.push(`${leg}: ${reason}`);
    recordAiLegFailure(`transcribe:${leg}`, reason);
  };

  // Ступень 1: нативный Gemini. generateContent принимает аудио тем же
  // inline_data, что и картинку с PDF; модель — резолвом, без хардкода id
  // (тот же урок, что у зрения: gemini-2.0-flash отвечает 404 «no longer
  // available» с 04.09).
  const geminiKey = getGeminiKey();
  const model = geminiKey ? await resolveGeminiModel() : null;
  if (!geminiKey) note('gemini', 'no_key');
  else if (!model) note('gemini', 'каталог моделей недоступен');
  else {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: mimeType, data: audioBase64 } },
                { text: TRANSCRIBE_PROMPT },
              ],
            }],
            generationConfig: { maxOutputTokens: 400 },
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        note('gemini', httpFailureReason(res.status, await res.text().catch(() => '')));
      } else {
        const data = await res.json();
        const leg = readTranscript(data?.candidates?.[0]?.content?.parts?.[0]?.text);
        if (leg.kind === 'text') return { ok: true, text: leg.text };
        if (leg.kind === 'unintelligible') return { ok: false, reason: 'unintelligible', detail: 'gemini' };
        note('gemini', leg.reason);
      }
    } catch (e) { note('gemini', errorFailureReason(e)); }
  }

  // Ступень 2: тот же Gemini через OpenRouter. С прода закрыт гео-блоком, с
  // раннера и в разработке — рабочий путь.
  const apiKey = getOpenRouterKey();
  if (!apiKey) note('openrouter', 'no_key');
  else {
    try {
      const res = await relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...openRouterAttribution(),
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              // Gemini принимает аудио через image_url с audio MIME-type
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${audioBase64}` } },
              { type: 'text', text: TRANSCRIBE_PROMPT },
            ],
          }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        note('openrouter', httpFailureReason(res.status, await res.text().catch(() => '')));
      } else {
        const data = await res.json();
        const leg = readTranscript(data?.choices?.[0]?.message?.content);
        if (leg.kind === 'text') return { ok: true, text: leg.text };
        if (leg.kind === 'unintelligible') return { ok: false, reason: 'unintelligible', detail: 'openrouter' };
        note('openrouter', leg.reason);
      }
    } catch (e) { note('openrouter', errorFailureReason(e)); }
  }

  return { ok: false, reason: 'unavailable', detail: failures.join('; ') || 'ступеней не осталось' };
}

// ── Gemini PDF Extraction via OpenRouter ──────────────────────
// Принимает PDF как base64, возвращает текст с извлечёнными данными.
// Используется для импорта туров из PDF-документов операторов.
export async function callGeminiPDF(
  pdfBase64: string,
  prompt: string,
): Promise<string | null> {
  // Приоритет 1: нативный Google Gemini API (стабилен с сервера, нативно читает PDF).
  // Модель — по /models: хардкод gemini-2.0-flash снят с эксплуатации (404, 04.09).
  const geminiKey = getGeminiKey();
  const pdfModel = geminiKey ? await resolveGeminiModel() : null;
  if (geminiKey && pdfModel) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${pdfModel}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
                { text: prompt },
              ],
            }],
          }),
          signal: AbortSignal.timeout(45_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text?.trim()) return text.trim();
      }
    } catch { /* fall through to OpenRouter */ }
  }

  // Приоритет 2 (fallback): тот же Gemini через OpenRouter.
  const apiKey = getOpenRouterKey();
  if (!apiKey) return null;
  try {
    const res = await relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...openRouterAttribution(),
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                file: { filename: 'passport.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch { return null; }
}

// ── Preflight: быстрая проверка доступности провайдеров ──────
// Минимальный запрос к каждому провайдеру, параллельно, 5s timeout
// Ключи в GitHub и Timeweb намеренно разные (решение владельца 23.08):
// отчёт обязан называть, какой именно отвечал и откуда его спросили.
export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  latency_ms?: number;
  error?: string;
}

export interface OpenRouterBalance {
  total_credits: number;
  total_usage: number;
  remaining: number | null; // null = pay-as-you-go (no limit)
  low: boolean;
}

/**
 * Проверяет баланс OpenRouter.
 *
 * Приоритет:
 *   1. OPENROUTER_MANAGEMENT_KEY → /api/v1/credits  (точный баланс, management key)
 *   2. OPENROUTER_API_KEY        → /api/v1/auth/key  (usage/limit, стандартный ключ)
 *
 * Добавь в Timeweb env:
 *   OPENROUTER_MANAGEMENT_KEY=sk-or-v1-mgmt-...
 */
export async function checkOpenRouterBalance(): Promise<OpenRouterBalance | null> {
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  const apiKey  = getOpenRouterKey();

  // ── Вариант 1: management key → /api/v1/credits ──────────────
  if (mgmtKey) {
    try {
      const res = await relayFetch(`${OPENROUTER_BASE}/credits`, {
        headers: { Authorization: `Bearer ${mgmtKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json() as {
          data: { total_credits: number; total_usage: number }
        };
        const { total_credits, total_usage } = json.data;
        const remaining = Math.round((total_credits - total_usage) * 100) / 100;
        return {
          total_credits: Math.round(total_credits * 100) / 100,
          total_usage:   Math.round(total_usage   * 100) / 100,
          remaining,
          low: remaining < 0.5,
        };
      }
    } catch { /* fallthrough */ }
  }

  // ── Вариант 2: стандартный API key → /api/v1/auth/key ────────
  if (!apiKey) return null;
  try {
    const res = await relayFetch(`${OPENROUTER_BASE}/auth/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      data: { usage: number; limit: number | null }
    };
    const { usage, limit } = json.data;
    // OR returns limit=999 as sentinel for "no hard limit" (pay-as-you-go)
    const effectiveLimit = limit != null && limit < 999 ? limit : null;
    const remaining = effectiveLimit != null ? Math.round((effectiveLimit - usage) * 100) / 100 : null;
    return {
      total_credits: effectiveLimit ?? 0,
      total_usage:   Math.round(usage * 100) / 100,
      remaining,     // null = pay-as-you-go, no hard limit
      low:           remaining != null && remaining < 0.5,
    };
  } catch {
    return null;
  }
}

export async function preflightProviders(): Promise<{
  providers: ProviderStatus[];
  any_available: boolean;
  openrouter_balance: OpenRouterBalance | null;
  /** Где спрашивали и какими ключами — иначе два отказа неразличимы. */
  place: RunPlace;
  keys: KeyReport[];
}> {
  const testMsg: ChatMessage[] = [{ role: 'user', content: 'ok' }];

  // Пробует провайдера и возвращает подробный статус (HTTP-код + тело ошибки)
  async function probeDetailed(
    id:     string,
    name:   string,
    fn:     () => Promise<{ ok: boolean; status?: number; error?: string }>,
  ): Promise<ProviderStatus> {
    const start = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise<{ ok: boolean; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: 'timeout 5s' }), 5000),
        ),
      ]);
      return {
        id,
        name,
        available:  result.ok,
        latency_ms: Date.now() - start,
        error:      result.ok ? undefined : result.error,
      };
    } catch (e) {
      return { id, name, available: false, latency_ms: Date.now() - start, error: String(e) };
    }
  }

  async function probeOpenrouter() {
    const apiKey = getOpenRouterKey();
    if (!apiKey) return { ok: false, error: 'OPENROUTER_API_KEY not set' };
    try {
      const res = await relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...openRouterAttribution(),
        },
        body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeDeepSeek() {
    const apiKey = getDeepSeekKey();
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY not set' };
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: await resolveDeepSeekModel(), max_tokens: 5, messages: testMsg, ...deepseekThinking() }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      // HTTP 200 — ещё не ответ: deepseek-v4-pro отдаёт 200 с пустым content
      // (02.08, 04.09). Зелёная проба при немом живом пути — §4.0.
      const data = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
      const text = data?.choices?.[0]?.message?.content;
      if (!text?.trim()) return { ok: false, status: 200, error: `HTTP 200, но content пуст: ${describeEmptyCompletion(data)}` };
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeXai() {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: 'XAI_API_KEY not set' };
    const model = await resolveXaiModel();
    if (!model) return { ok: false, error: `модель не разрешена: ${xaiResolveProblem() ?? 'каталог недоступен'}` };
    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeFugu() {
    const apiKey = getFuguKey();
    if (!apiKey) return { ok: false, error: 'FUGU_API_KEY not set' };
    let base = (process.env.FUGU_BASE_URL || 'https://api.sakana.ai').replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base = `${base}/v1`;
    const model = process.env.FUGU_MODEL || 'fugu';
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_completion_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeGroq() {
    const apiKey = getGroqKey();
    if (!apiKey) return { ok: false, error: 'GROQ_API_KEY not set' };
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeCerebras() {
    const apiKey = getCerebrasKey();
    if (!apiKey) return { ok: false, error: 'CEREBRAS_API_KEY not set' };
    try {
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: CEREBRAS_MODEL, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeMistral() {
    const apiKey = getMistralKey();
    if (!apiKey) return { ok: false, error: 'MISTRAL_API_KEY not set' };
    try {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MISTRAL_MODEL, max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeAnthropic() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
    try {
      const res = await relayFetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ok' }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  /**
   * Три ноги, которых в преполётной проверке НЕ БЫЛО до 23.08, — а именно они
   * решают судьбу судьи фактгейта и Кузьмича. Проверка могла показывать
   * «DeepSeek жив» при мёртвом Qwen/Gemini/Kimi, и владелец видел зелёный
   * экран рядом с молчащим Разведчиком.
   *
   * Проба спрашивает ФОРМАТ json там, где его просит живой путь: провайдер,
   * который отвечает на голый запрос и падает на response_format, иначе
   * остался бы зелёным.
   */
  /**
   * Вторая строка по DeepSeek — ПУТЬ СУДЬИ, а не путь чата (23.08).
   *
   * Замер владельца на проде: `deepseek` зелёный, 381 мс, — и одновременно
   * Разведчик сообщает «не ответил ни один провайдер». Противоречия здесь нет:
   * проба и судья спрашивают РАЗНОЕ. Проба берёт модель назначения `chat`
   * (resolveDeepSeekModel), просит 5 токенов и не просит формат. Судья идёт
   * через callAIQuality: модель назначения `content` (другая переменная
   * окружения, другой выбор из /v1/models), 1600 токенов, temperature 0 и
   * обязательный response_format: json_object.
   *
   * Проверка, которая не ходит живым путём, зелёная ровно настолько, насколько
   * бесполезная. Поэтому путь судьи проверяется отдельной строкой — тем же
   * запросом, каким ходит он сам.
   */
  async function probeDeepSeekContent() {
    const apiKey = getDeepSeekKey();
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY not set' };
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: await resolveContentModel('deepseek'),
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: 'user', content: 'Верни JSON {"ok":true}' }],
          response_format: { type: 'json_object' },
          ...deepseekThinking(),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data?.choices?.[0]?.message?.content;
      if (!text?.trim()) return { ok: false, error: 'пустой ответ на пути судьи' };
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeQwen() {
    const { apiKey, base, model: configured } = getQwenConfig();
    if (!apiKey) return { ok: false, error: 'DASHSCOPE_API_KEY not set' };
    // Та модель, в которую сейчас ходит живой путь (квота по моделям, 25.09).
    const model = (await nextQwenToolsModel(configured)) ?? configured;
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 5, messages: testMsg, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (isFreeQuotaExhausted(res.status, body)) markFreeQuotaExhausted(model);
        return { ok: false, status: res.status, error: `HTTP ${res.status} (${model}): ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeKimi() {
    const apiKey = getMoonshotKey();
    if (!apiKey) return { ok: false, error: 'MOONSHOT_API_KEY not set' };
    try {
      const res = await fetch(`${MOONSHOT_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: await resolveKimiModel(), max_tokens: 5, messages: testMsg }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  async function probeGeminiDirect() {
    const apiKey = getGeminiKey();
    if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not set' };
    // Та же модель, что у живого пути (по /models): проба на снятом с
    // эксплуатации id отвечала 404 при живом ключе и живой модели.
    const model = await resolveGeminiModel();
    if (!model) return { ok: false, error: `модель не разрешена: ${geminiResolveProblem() ?? 'список моделей недоступен'}` };
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }] }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  const [providers, openrouter_balance] = await Promise.all([
    Promise.all([
      // MiMo в преполётной проверке нет: прямой эндпоинт Xiaomi отключён 04.07.2026,
      // и вечно красная строка про выключенное по решению — шум, а не диагноз.
      probeDetailed('openrouter', 'OpenRouter (GPT-4o-mini)',     probeOpenrouter),
      probeDetailed('deepseek',   'DeepSeek-V3 (DeepSeek)',       probeDeepSeek),
      probeDetailed('deepseek:content', 'DeepSeek путь судьи (content + json)', probeDeepSeekContent),
      probeDetailed('qwen',       'Qwen (DashScope, json)',       probeQwen),
      probeDetailed('kimi',       'Kimi (Moonshot)',              probeKimi),
      probeDetailed('gemini',     'Gemini (прямой, модель по /models)', probeGeminiDirect),
      probeDetailed('fugu',       'Sakana Fugu',                  probeFugu),
      probeDetailed('groq',       'Groq (Llama 3.3-70B)',         probeGroq),
      probeDetailed('cerebras',   'Cerebras (Llama 3.3-70B)',     probeCerebras),
      probeDetailed('mistral',    'Mistral (small)',              probeMistral),
    ]),
    checkOpenRouterBalance(),
  ]);

  return {
    providers,
    any_available: providers.some(p => p.available),
    openrouter_balance,
    place: runPlace(),
    keys: keyReport(),
  };
}

// ── Race Helper: first non-empty result from parallel calls ──────
async function raceProviders(calls: Promise<string | null>[]): Promise<string | null> {
  return (await raceProvidersLabelled(calls.map(call => ({ provider: 'unknown', call }))))?.text ?? null;
}

/** Победитель гонки вместе с именем провайдера. */
interface RaceWinner { provider: string; text: string }

/**
 * Та же гонка, но помнит, КТО ответил.
 *
 * Без этого вызывающий получал строку и не знал, чей это ответ: водопад
 * молча меняет провайдера — в этом его смысл, — и «Кузьмич стал отвечать
 * хуже» невозможно было разложить на «сменился провайдер», «поправили
 * промпт» и «инструмент не ответил». Имя победителя стоит ноль запросов:
 * оно уже известно в момент вызова, его просто теряли.
 */
async function raceProvidersLabelled(
  entries: Array<{ provider: string; call: Promise<string | null> }>,
): Promise<RaceWinner | null> {
  return new Promise<RaceWinner | null>((resolve) => {
    let pending = entries.length;
    if (pending === 0) { resolve(null); return; }
    let settled = false;
    entries.forEach(({ provider, call }) =>
      call.then(result => {
        if (!settled && result?.trim()) { settled = true; resolve({ provider, text: result }); }
      }).catch(() => {}).finally(() => {
        pending--;
        if (pending === 0 && !settled) resolve(null);
      })
    );
  });
}

// ── Meta Muse Spark ───────────────────────────────────────────
// Анонсирована 08.04.2026. API пока закрыт (select partners).
// Активируется автоматически при выставлении MUSE_SPARK_API_KEY в Timeweb.
// Нативно мультимодальная, Contemplating mode (multi-agent reasoning).
// Ожидаемый endpoint — meta.ai OpenAI-compatible API (уточнить при открытии).
export async function callMuseSpark(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getMuseSparkKey();
  if (!apiKey) return null; // API ещё закрыт — пропускаем без ошибки

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    // Endpoint уточнить когда Meta откроет публичный API
    const res = await fetch('https://api.meta.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'muse-spark',
        temperature: 0.4,
        max_tokens: 800,
        messages: payload,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content as string) ?? null;
  } catch {
    return null;
  }
}

// ── Sakana AI Fugu ──────────────────────────────────────────
// OpenAI-compatible API (Chat Completions). Ключ FUGU_API_KEY (формат fish_...).
// Base URL настраивается через FUGU_BASE_URL (по докам Sakana), дефолт api.sakana.ai.
// Модель: FUGU_MODEL (fugu — быстрая дефолтная / fugu-ultra — максимум качества).
export async function callFugu(messages: ChatMessage[]): Promise<string | null> {
  const apiKey = getFuguKey();
  if (!apiKey) return null;

  // База: FUGU_BASE_URL, нормализуем до .../v1
  let base = (process.env.FUGU_BASE_URL || 'https://api.sakana.ai').replace(/\/+$/, '');
  if (!base.endsWith('/v1')) base = `${base}/v1`;
  const model = process.env.FUGU_MODEL || 'fugu';

  try {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 800,  // fugu-ultra: лимит только на финальный ответ
        messages: payload,
      }),
      signal: AbortSignal.timeout(45_000),  // ultra оркеструет несколько агентов — дольше
    });

    if (!res.ok) return null;
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content as string) ?? null;
  } catch {
    return null;
  }
}

// ── Waterfall: race tiers for speed ─────────────────────────
// Tier 1: OpenRouter + DeepSeek + Gemini + MiMo + MuseSpark — race (кто быстрее)
// Tier 2: Yandex + MiniMax — fallback
// Tier 3: Anthropic — sequential fallback
//
// Fugu Ultra сюда сознательно НЕ включена: raceProviders() не отменяет
// проигравшие вызовы — они дожидаются полного ответа в фоне и всё равно
// тарифицируются. Оркестрация Fugu Ultra стоит ~1260 токенов оверхеда на
// запрос и отвечает за ~20с против 2-8с у остальных Tier 1 — она проигрывает
// гонку почти всегда, но деньги списываются каждый раз. Fugu используется
// точечно там, где задержка не важна: lib/agents/editor.ts (A/B вариант B,
// прямой callFugu()) и app/api/admin/test-fugu (ручная проверка).
/**
 * Чем произведён ответ водопада.
 *
 * `provider` — кто ответил на самом деле; `tier` — какой эшелон, то есть
 * отвечал ли первый выбор или его пришлось заменять. `null` в обоих полях
 * значит «не ответил никто» и идёт вместе с `failed: true`.
 *
 * Модели здесь НЕТ намеренно. Провайдерские вызовы её не возвращают, и
 * выводить её из имени провайдера значило бы записать догадку рядом с
 * фактами (§4.0). Понадобится — придётся вернуть её из самих вызовов, а не
 * дорисовать здесь.
 */
export interface WaterfallOutcome {
  text: string;
  provider: string | null;
  tier: 1 | 2 | 3 | null;
  /** Ответ — фолбэк-строка о недоступности, а не ответ модели. */
  failed: boolean;
}

export async function callAIWaterfall(messages: ChatMessage[]): Promise<string> {
  return (await callAIWaterfallDetailed(messages)).text;
}

/**
 * Тот же водопад, но говорит, кто ответил.
 *
 * Реализация ОДНА: `callAIWaterfall` — обёртка над этой функцией. Вторая
 * копия водопада разошлась бы с первой ровно так же, как разошлись две копии
 * создания брони (08.09), и разница была бы не видна до дня, когда она
 * дорого стоит.
 */
export async function callAIWaterfallDetailed(messages: ChatMessage[]): Promise<WaterfallOutcome> {
  // Tier 1: race all primary providers simultaneously.
  // MiMo (прямой api.xiaomimimo.com) отключён 04.07.2026 — эндпоинт не отвечал
  // (health WARN), а в гонке он лишь тратил соединение и шумел в мониторинге.
  // Если MiMo снова понадобится — вернуть через OpenRouter (модель-id в OR_MODELS),
  // а не прямым вызовом Xiaomi. Функция callMiMo оставлена для этого.
  const tier1 = await raceProvidersLabelled([
    { provider: 'openrouter', call: callOpenrouter(messages) },
    { provider: 'deepseek',   call: callDeepSeek(messages) },
    { provider: 'gemini',     call: callGeminiDirect(messages) },
    { provider: 'glm',        call: callGLM(messages) },
    { provider: 'nvidia',     call: callNvidia(messages) },    // NVIDIA NIM: Llama 3.3-70B бесплатно
    { provider: 'groq',       call: callGroq(messages) },      // Groq: Llama 3.3-70B бесплатно (US — проверить geo)
    { provider: 'cerebras',   call: callCerebras(messages) },  // Cerebras: Llama 3.3-70B бесплатно (US — проверить geo)
    { provider: 'mistral',    call: callMistral(messages) },   // Mistral: mistral-small бесплатно (EU — проверить geo)
    { provider: 'muse_spark', call: callMuseSpark(messages) }, // активируется когда Meta откроет API
  ]);
  if (tier1) return { text: tier1.text, provider: tier1.provider, tier: 1, failed: false };

  // Tier 2: race mid-tier fallbacks
  //
  // xAI добавлен 04.09 по замеру: до этого дня callXai не звался НИ ОДНИМ
  // живым путём — только админской проверкой, — и провайдер, который отвечает,
  // числился мёртвым. Здесь берётся быстрая модель каталога (13 с по замеру),
  // а не флагман (43 с): во втором эшелоне ждёт человек, которому первый
  // эшелон уже не ответил.
  const tier2 = await raceProvidersLabelled([
    { provider: 'yandex',  call: callYandexGPT(messages) },
    { provider: 'minimax', call: callMiniMax(messages) },
    { provider: 'xai',     call: callXai(messages, { purpose: 'fast' }) },
  ]);
  if (tier2) return { text: tier2.text, provider: tier2.provider, tier: 2, failed: false };

  // Tier 3: sequential fallback (rarely reached)
  const anthropic = await callAnthropic(messages);
  if (anthropic) return { text: anthropic, provider: 'anthropic', tier: 3, failed: false };

  // All providers failed — log for Timeweb server diagnostics
  console.error('[AI] All providers failed. Configured keys:', {
    OR: !!getOpenRouterKey(),
    DeepSeek: !!process.env.DEEPSEEK_API_KEY,
    Gemini: !!process.env.GEMINI_API_KEY,
    Anthropic: !!process.env.ANTHROPIC_API_KEY,
    Yandex: !!(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID),
    MiniMax: !!(process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID),
    OR_disabled_until: openRouterDisabledUntil > 0 ? new Date(openRouterDisabledUntil).toISOString() : 'none',
    // Перечень ключей отвечает «ключ есть», но не «что ответил провайдер».
    // Без этого на вопрос «баланс на месте, почему недоступен» ответить нечем.
    failures: recentProviderFailures(),
  });
  // Не ответил никто: провайдер и эшелон — null, и это не «ответил кто-то
  // безымянный». Флаг failed отличает фолбэк-строку от настоящего ответа для
  // тех вызывающих, кто не сверяет текст с isWaterfallErrorResponse.
  return {
    text: 'Извините, сервис временно недоступен. Попробуйте позже.',
    provider: null, tier: null, failed: true,
  };
}

// Sentinel-строки фолбэков waterfall/fast: при отказе всех провайдеров
// возвращается строка, а не исключение. Роуты ОБЯЗАНЫ проверять ответ этим
// хелпером, иначе ошибка уедет клиенту как обычный текст со статусом 200 —
// у AI Спасателя это прятало локальный протокол выживания (issue #27).
const WATERFALL_ERROR_PREFIXES = [
  'Извините, сервис временно недоступен',
  'Сервис временно недоступен',
];

export function isWaterfallErrorResponse(text: string): boolean {
  return WATERFALL_ERROR_PREFIXES.some(p => text.startsWith(p));
}

/**
 * Путь для ГЕНЕРАЦИИ КОНТЕНТА: сильнейшее из доступного, а не самое быстрое.
 *
 * Отличие от callAIFast принципиальное, и оно не в моделях, а в устройстве.
 * callAIFast — ГОНКА: побеждает тот, кто ответил первым, то есть маленькая
 * быстрая модель. Для JSON-ответов и голосования это правильно. Для текста,
 * который прочитают люди, — нет: мы систематически выбирали скорость вместо
 * качества и получали слабые тексты при живых сильных провайдерах.
 *
 * Здесь провайдеры идут ПО ОЧЕРЕДИ: DeepSeek (сильнейший из достижимых из РФ
 * напрямую), затем Qwen, и лишь потом общий waterfall. Модель у обоих не
 * захардкожена — resolveContentModel спрашивает провайдера (CLAUDE.md §8).
 *
 * Флагманы Claude/GPT сюда не ставим: из РФ они гео-блокируются и без релея
 * дают только задержку. Появится релей — waterfall в конце их и подхватит.
 */
export async function callAIQuality(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean; deepThinking?: boolean } = {},
): Promise<string> {
  // `deepThinking` (по умолчанию true — прежнее поведение для прозы) даёт
  // структурированным вызывающим отказаться от размышления.
  //
  // Разбор панели 12.09 (scout-innovator, «модель=quality: ответ оборван…
  // после дедупа/критика осталось 0»): арифметика двух реальных прогонов
  // показала, что размышление не фиксировано, а РАСТЯГИВАЕТСЯ под бюджет.
  // maxTokens подняли 800→3000 (05.09, комментарий ниже у deepThinkingBudget)
  // — общий бюджет вырос на 2200 токенов, а точка обрыва ответа сдвинулась
  // с ~2440 до ~2527 символов, то есть меньше чем на 100. Прибавка бюджета
  // ушла в ДОПОЛНИТЕЛЬНОЕ размышление, а не в ответ: фиксированная надбавка
  // +1500 у `deepThinkingBudget` калибровалась по короткой задаче (575-686
  // знаков рассуждения) и не держит многошаговый анализ 2-3 предложений с
  // шагами и критериями. Поднимать потолок ещё раз — та же попытка третий
  // раз подряд без причины ждать другого исхода.
  //
  // У scout-innovator результат думания и так проверяет ОТДЕЛЬНЫЙ LLM-критик
  // (criticReviewProposal) ниже по цепочке — вторая проверка качества уже
  // есть, и получить полный, но менее «глубоко обдуманный» JSON лучше, чем
  // надёжно получать 0 предложений после обрыва. Для прозы (Editor, Scout
  // Digest, посты в канал) размышление остаётся включённым — там владелец
  // явно выбрал глубину важнее скорости (04.09, см. deepThinkingBudget).
  const { maxTokens = 1600, temperature = 0.5, json = false, deepThinking = true } = opts;
  const payload = messages.map(({ role, content }) => ({ role, content }));
  // Формат просим у ПРОВАЙДЕРА, а не уговариваем словами в промпте. DeepSeek и
  // Qwen — OpenAI-совместимые и response_format понимают; водопад-запасной путь
  // ниже поле игнорирует, и это допустимо: разбор с повтором у вызывающего
  // остаётся страховкой. Появилось 23.08 ради судьи фактгейта — см. ниже.
  const format = json ? { response_format: { type: 'json_object' } } : {};

  // 1. DeepSeek — сильнейший прямо достижимый из РФ.
  //
  // Отказ каждого шага называется вслух (23.08). До этого дня и «ключа нет», и
  // «402 кончились деньги», и «таймаут» одинаково молча роняли путь на
  // следующего провайдера — а когда молчали все, наверх приходило «не ответил
  // ни один». Владелец при этом видел ключ на месте и упирался в тупик.
  const dsKey = getDeepSeekKey();
  if (!dsKey) recordAiLegFailure('deepseek:content', 'no_key');
  if (dsKey) {
    try {
      const model = await resolveContentModel('deepseek');
      // Путь генерации ТЕКСТА для людей: размышление включено, потолок
      // покрывает и его, и ответ. Иначе получаем ровно то, на что жалуется
      // владелец, — быстрый поверхностный текст. Для structured-JSON
      // вызывающих с deepThinking=false потолок — сам maxTokens, без
      // надбавки: размышления нет, весь бюджет достаётся ответу.
      const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dsKey}` },
        body: JSON.stringify({
          model, temperature,
          max_tokens: deepThinking ? deepThinkingBudget(maxTokens) : maxTokens,
          messages: payload, ...format, ...deepseekThinking(deepThinking ? 'deep' : 'fast'),
        }),
      }, { timeoutMs: 90_000, label: 'deepseek:content' });
      if (res.ok) {
        const data = await res.json() as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
          usage?: ProviderUsage;
        };
        const text = data?.choices?.[0]?.message?.content;
        if (text?.trim() && completionTruncated(data)) {
          // Токены потрачены — в книги, но ответом обрывок не считается.
          logLLMUsage(answeredModel(model, data), data.usage);
          const reasoningLen = data?.choices?.[0]?.message?.reasoning_content?.length ?? 0;
          recordAiLegFailure('deepseek:content', `truncated (${model}): finish_reason=length, ответ ${text.length} знаков, размышление ${reasoningLen} знаков, maxTokens=${maxTokens}`);
        } else if (text?.trim()) {
          logLLMUsage(answeredModel(model, data), data.usage);
          // Диагностика для следующего разбора обрыва (см. пояснение выше у
          // `deepThinking`): без этой строки узнать, сколько бюджета съело
          // размышление, можно было только повторной догадкой. reasoning_content
          // есть только при deepThinking=true — при fast-режиме поле пустое.
          const reasoningLen = data?.choices?.[0]?.message?.reasoning_content?.length ?? 0;
          if (reasoningLen > 0) {
            console.error(`[AI] deepseek:content размышление=${reasoningLen}знаков ответ=${text.length}знаков maxTokens=${maxTokens}`);
          }
          return text;
        } else {
          recordAiLegFailure('deepseek:content', `empty (${model}): ${describeEmptyCompletion(data)}`);
        }
      } else {
        recordAiLegFailure('deepseek:content', httpFailureReason(res.status, await res.text().catch(() => '')));
      }
    } catch (e) { recordAiLegFailure('deepseek:content', errorFailureReason(e)); }
  }

  // 2. Qwen — второй сильный, тоже без гео-блока.
  const qwen = getQwenConfig();
  if (!qwen.apiKey) recordAiLegFailure('qwen:content', 'no_key');
  if (qwen.apiKey) {
    try {
      const model = await resolveContentModel('qwen');
      const res = await fetchWithRetry(`${qwen.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qwen.apiKey}` },
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: payload, ...format }),
      }, { timeoutMs: 45_000, label: 'qwen:content' });
      if (res.ok) {
        const data = await res.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>; usage?: ProviderUsage };
        const text = data?.choices?.[0]?.message?.content;
        if (text?.trim() && completionTruncated(data)) {
          logLLMUsage(answeredModel(model, data), data.usage);
          recordAiLegFailure('qwen:content', `truncated (${model}): finish_reason=length, ответ ${text.length} знаков, maxTokens=${maxTokens}`);
        } else if (text?.trim()) {
          logLLMUsage(answeredModel(model, data), data.usage);
          return text;
        } else {
          recordAiLegFailure('qwen:content', `empty (${model}): ${describeEmptyCompletion(data)}`);
        }
      } else {
        recordAiLegFailure('qwen:content', httpFailureReason(res.status, await res.text().catch(() => '')));
      }
    } catch (e) { recordAiLegFailure('qwen:content', errorFailureReason(e)); }
  }

  // 3. xAI — флагман, достижимый из РФ напрямую (замер 04.09: дорога открыта,
  //    grok-4.6 отвечает за 43 с). Здесь генерируется ТЕКСТ для людей, и
  //    ночному крону эти секунды по карману; ставить его выше DeepSeek
  //    незачем — тот отвечает за треть секунды.
  const xaiText = await callXai(messages, { purpose: 'strong', timeoutMs: 90_000, maxTokens, rejectTruncated: true });
  if (xaiText?.trim()) return xaiText;

  // 4. Общий waterfall — включая флагманы, если релей настроен.
  return callAIWaterfall(messages);
}

/** Как callAIQuality, но отказ виден как null, а не строкой-заглушкой. */
export async function callAIQualityOrNull(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean; deepThinking?: boolean } = {},
): Promise<string | null> {
  const text = await callAIQuality(messages, opts);
  return isWaterfallErrorResponse(text) ? null : text;
}

/**
 * Тот же водопад, но отказ виден как `null`, а не как строка-заглушка.
 *
 * Повод (04.09, экран владельца). Scout-Innovator показал в панели диагноз
 * «в ответе нет JSON-массива (len=55, head="Извините, сервис временно
 * недоступен...")». Разбор был прав по букве и лгал по сути: массива и правда
 * нет, но не потому, что модель ответила плохо, а потому, что не ответил
 * НИКТО, и в разбор уехала заглушка водопада. Диагноз назвал вторичное
 * следствие вместо причины, и на панели это выглядело как капризная модель, а
 * не как мёртвые провайдеры.
 *
 * `callAIWaterfall` обязан возвращать строку: её показывают человеку в чате,
 * где пустой ответ хуже извинения. Но всякий, кто ответ РАЗБИРАЕТ, а не
 * показывает, должен получать честный null — как уже сделано у
 * callAIQualityOrNull и callAIFastOrNull.
 */
export async function callAIWaterfallOrNull(messages: ChatMessage[]): Promise<string | null> {
  const text = await callAIWaterfall(messages);
  return isWaterfallErrorResponse(text) ? null : text;
}

// ── Fast Waterfall — race cheap providers ────────────────────
// Для структурированных задач (JSON, бинарные ответы, голосование).
// Races DeepSeek + MiMo + Gemini simultaneously.
/**
 * Заглушка callAIFast при отказе ВСЕХ быстрых провайдеров. Ровно 27 символов —
 * именно её Editor опознавал эвристикой по длине и потому писал «вероятно
 * заглушка». Для новых вызовов есть callAIFastOrNull: отказ виден как null,
 * без угадывания.
 */
export const AI_FAST_UNAVAILABLE = 'Сервис временно недоступен.';

/**
 * Опции быстрой ветки. Обе появились 22.08 из-за судьи фактгейта.
 *
 * `maxTokens` — потолок ответа. По умолчанию у ног гонки 600-800 токенов:
 * для реплики в чате достаточно, а судья обязан ЦИТИРОВАТЬ неподтверждённые
 * утверждения, и на длинном выпуске обрывался на середине. Оборванный JSON
 * не имеет закрывающей скобки, разбор его не берёт — и отказ назывался
 * «ответила прозой», хотя модель отвечала правильно и просто не поместилась.
 *
 * `json` — просить у провайдера ФОРМАТ, а не уговаривать словами. Просьба
 * «верни ТОЛЬКО JSON» в системном промпте — не гарантия; response_format
 * у DeepSeek/OpenRouter — гарантия. Кто формата не умеет, работает как
 * прежде: разбор и один повтор остаются страховкой.
 */
export interface FastCallOptions {
  maxTokens?: number;
  json?: boolean;
  /**
   * Свой предел ожидания ноги гонки (22.08).
   *
   * У ног быстрой ветки 20 секунд: для короткой реплики достаточно. Судья
   * фактгейта получает на вход до 9000 знаков источников плюс сам выпуск —
   * и не укладывается. Качественный путь на тех же провайдерах ждёт 45
   * секунд и отвечает: 22.08 синтез прошёл, а судья на том же прогоне
   * вернул «не ответил никто». Разница между ними — только предел ожидания.
   */
  timeoutMs?: number;
}

/**
 * Быстрый вызов, честный к отказу: null — не ответил НИ ОДИН провайдер.
 * Обычный callAIFast для совместимости подставляет строку-заглушку, из-за чего
 * вызывающий не мог отличить «модель так ответила» от «всё упало».
 */
export async function callAIFastOrNull(
  messages: ChatMessage[],
  opts?: FastCallOptions,
): Promise<string | null> {
  const text = await callAIFast(messages, opts);
  return text === AI_FAST_UNAVAILABLE ? null : text;
}

export async function callAIFast(
  messages: ChatMessage[],
  opts?: FastCallOptions,
): Promise<string> {
  const apiKey = getOpenRouterKey();

  // MiMo убран 04.07.2026 — прямой api.xiaomimimo.com не отвечал (см. callAIWaterfall).
  // callKimi — третий достижимый из РФ провайдер: нет MOONSHOT_API_KEY → null,
  // из гонки выпадает. Оживляет судью фактгейта, когда DeepSeek/Gemini молчат.
  const calls: Promise<string | null>[] = [
    callDeepSeek(messages, opts),
    callGeminiDirect(messages, opts),
    callKimi(messages, opts),
  ];

  // DeepSeek via OpenRouter (inline to avoid extra function)
  if (!apiKey) recordAiLegFailure('openrouter', 'no_key');
  else if (isOpenRouterTemporarilyDisabled()) recordAiLegFailure('openrouter', 'выключен после 401');
  if (apiKey && !isOpenRouterTemporarilyDisabled()) {
    const payload = messages.map(({ role, content }) => ({ role, content }));
    calls.push(
      relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...openRouterAttribution(),
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat-v3-0324',
          temperature: 0.3,
          max_tokens: opts?.maxTokens ?? 600,
          messages: payload,
          ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 12_000),
      })
        .then(async (res) => {
          if (!res.ok) {
            if (res.status === 401) {
              markOpenRouterAuthFailure();
            }
            recordAiLegFailure('openrouter', httpFailureReason(res.status, await res.text().catch(() => '')));
            return null;
          }
          clearOpenRouterFailure();
          return res.json();
        })
        .then(data => {
          const text = (data?.choices?.[0]?.message?.content as string) ?? null;
          if (data && !text) recordAiLegFailure('openrouter', 'empty');
          return text;
        })
        .catch((e) => { recordAiLegFailure('openrouter', errorFailureReason(e)); return null; })
    );
  }

  const result = await raceProviders(calls);
  return result ?? AI_FAST_UNAVAILABLE;
}

/** Like callAIWithModel but returns plain string (for callsites that don't need model_used). */
export async function callAIWithModelDirect(
  messages: ChatMessage[],
  preferredModel?: string | null,
): Promise<string> {
  const { text } = await callAIWithModel(messages, preferredModel);
  return text;
}

// ── Debug Waterfall: диагностика каждого провайдера ──────────
export interface WaterfallDebugResult {
  provider: string;
  model: string;
  status: 'success' | 'no_key' | 'http_error' | 'empty_response' | 'error_in_body' | 'exception';
  http_status?: number;
  error?: string;
  answer_preview?: string;
  latency_ms: number;
  /**
   * Известное об этом отказе, когда текст провайдера вводит в заблуждение
   * (lib/ai/refusal-notes). Ответ провайдера при этом остаётся дословным в
   * `error`: заметка добавляется, а не заменяет.
   */
  note?: string;
}

export async function callAIWaterfallDebug(messages: ChatMessage[]): Promise<WaterfallDebugResult[]> {
  const results: WaterfallDebugResult[] = [];
  const payload = messages.map(({ role, content }) => ({ role, content }));

  // 1. Qwen (DashScope) — второй сильный на пути судьи и первый в tools-цикле
  //    Кузьмича. До 04.09 в этой пробе стоял MiMo, выключенный из водопада ещё
  //    04.07 (прямой эндпоинт Xiaomi отвечал «Unsupported model»), а Qwen —
  //    живой путь — не пробовался вовсе: диагностика красила мёртвое и
  //    молчала о живом.
  {
    const start = Date.now();
    const { apiKey, base, model } = getQwenConfig();
    if (!apiKey) {
      results.push({ provider: 'qwen', model, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'qwen', model, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push(text
            ? { provider: 'qwen', model, status: 'success', answer_preview: text.slice(0, 100), latency_ms: ms }
            : { provider: 'qwen', model, status: 'empty_response', error: describeEmptyCompletion(data), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'qwen', model, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 2. OpenRouter (each model)
  {
    const apiKey = getOpenRouterKey();
    if (!apiKey) {
      results.push({ provider: 'openrouter', model: 'all', status: 'no_key', latency_ms: 0 });
    } else {
      for (const { id, timeout } of OR_MODELS) {
        const start = Date.now();
        try {
          const res = await relayFetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...openRouterAttribution(),
            },
            body: JSON.stringify({ model: id, temperature: 0.4, max_tokens: 200, messages: payload }),
            signal: AbortSignal.timeout(timeout),
          });
          const ms = Date.now() - start;
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            results.push({ provider: 'openrouter', model: id, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
          } else {
            const data = await res.json();
            if (data?.error) {
              results.push({ provider: 'openrouter', model: id, status: 'error_in_body', error: JSON.stringify(data.error).slice(0, 200), latency_ms: ms });
            } else {
              const text = data?.choices?.[0]?.message?.content;
              results.push({ provider: 'openrouter', model: id, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
            }
          }
        } catch (e) {
          results.push({ provider: 'openrouter', model: id, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
        }
      }
    }
  }

  // 3. YandexGPT
  {
    const start = Date.now();
    const apiKey = process.env.YANDEX_API_KEY;
    const folderId = process.env.YANDEX_FOLDER_ID;
    if (!apiKey || !folderId) {
      results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const yMessages = messages.filter(m => m.role !== 'system').map(({ role, content }) => ({
          role: role === 'assistant' ? 'assistant' : 'user', text: content,
        }));
        const systemMsg = messages.find(m => m.role === 'system');
        if (systemMsg) yMessages.unshift({ role: 'system', text: systemMsg.content });

        const res = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${apiKey}`, 'x-folder-id': folderId },
          body: JSON.stringify({ modelUri: `gpt://${folderId}/yandexgpt-5.1/latest`, completionOptions: { stream: false, temperature: 0.4, maxTokens: '200' }, messages: yMessages }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.result?.alternatives?.[0]?.message?.text;
          results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'yandex', model: 'yandexgpt-5.1', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 4. DeepSeek direct — пригодные модели из /models и три формы запроса.
  //    run 6 (04.09): deepseek-v4-pro отдал finish_reason=length, content пуст,
  //    reasoning_content 676 знаков — модель ДУМАЕТ, и на 200 токенов бюджета
  //    ответа не остаётся; у судьи (1600) и решателя (1500) исход тот же на
  //    длинных промптах. Какой рычаг это лечит — thinking выключить, бюджет
  //    шире, другая модель линейки — документация DeepSeek из РФ и из
  //    песочницы не читается, значит меряем: каждая строка ниже — один рычаг.
  //    Базовая форма ответила — рычаги не пробуются; account-wide отказ
  //    (401/402/403/429) — остальные формы не спасут.
  {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'deepseek', model: 'unresolved', status: 'no_key', latency_ms: 0 });
    } else {
      const primary = await resolveDeepSeekModel().catch(() => null);
      const listed = classifyModels(await getProviderModelIds('deepseek')).filter(m => m.eligible).map(m => m.id);
      const models = [...new Set([...(primary ? [primary] : []), ...listed])].slice(0, 2);
      // Базовая форма — та, какой ходит живой путь (deepseekThinking). Рычаги
      // ниже пробуются только если она молчит: run 7 показал, что оба
      // (thinking выключен / бюджет 2000) спасают, живой путь взял первый.
      const variants: Array<{ tag: string; extra: Record<string, unknown>; timeoutMs: number }> = [
        { tag: '', extra: { max_tokens: 200, ...deepseekThinking() }, timeoutMs: 15_000 },
        { tag: ' [thinking:disabled]', extra: { max_tokens: 200, thinking: { type: 'disabled' } }, timeoutMs: 15_000 },
        { tag: ' [thinking:on max_tokens:2000]', extra: { max_tokens: 2000 }, timeoutMs: 60_000 },
      ];
      for (const dsModel of models) {
        for (const v of variants) {
          const start = Date.now();
          const label = `${dsModel}${v.tag}`;
          try {
            const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ model: dsModel, temperature: 0.4, messages: payload, ...v.extra }),
              signal: AbortSignal.timeout(v.timeoutMs),
            });
            const ms = Date.now() - start;
            if (!res.ok) {
              const errText = await res.text().catch(() => '');
              results.push({ provider: 'deepseek', model: label, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
              if ([401, 402, 403, 429].includes(res.status)) break;
              continue;
            }
            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content;
            results.push(text
              ? { provider: 'deepseek', model: label, status: 'success', answer_preview: text.slice(0, 100), latency_ms: ms }
              : { provider: 'deepseek', model: label, status: 'empty_response', error: describeEmptyCompletion(data), latency_ms: ms });
            if (text && v.tag === '') break;
          } catch (e) {
            results.push({ provider: 'deepseek', model: label, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
          }
        }
      }
    }
  }

  // 5. Gemini direct — модель по /models, как у живого пути. Хардкод
  //    gemini-2.0-flash здесь отвечал 404 «no longer available» и красил
  //    Gemini мёртвым при живом ключе (run 4, 04.09).
  {
    const start = Date.now();
    const apiKey = process.env.GEMINI_API_KEY;
    const gModel = apiKey ? await resolveGeminiModel() : null;
    if (!apiKey) {
      results.push({ provider: 'gemini', model: 'unresolved', status: 'no_key', latency_ms: 0 });
    } else if (!gModel) {
      results.push({ provider: 'gemini', model: 'unresolved', status: 'exception', error: `список моделей недоступен: ${geminiResolveProblem() ?? 'причина не записана'}`, latency_ms: Date.now() - start });
    } else {
      try {
        const systemMsg = messages.find(m => m.role === 'system');
        const turns = messages.filter(m => m.role !== 'system');
        const contents = turns.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] }));
        const reqBody: Record<string, unknown> = { contents };
        if (systemMsg) reqBody.systemInstruction = { parts: [{ text: systemMsg.content }] };

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'gemini', model: gModel, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          results.push({ provider: 'gemini', model: gModel, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'gemini', model: gModel, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 6. xAI — модель из каталога, плюс отдельной строкой ДОРОГА до api.x.ai
  //    без ключа: «Incorrect API key» с прода имеет два кандидата (гео-отказ и
  //    вопрос к ключу или счёту), и различает их только проба без ключа.
  {
    const reach = await probeXaiReachable();
    results.push({
      provider: 'xai:reachability',
      model: 'без ключа, /v1/models',
      status: reach.reached === true ? 'success' : reach.reached === false ? 'error_in_body' : 'exception',
      error: reach.reached === true ? undefined : reach.detail,
      answer_preview: reach.reached === true ? reach.detail : undefined,
      latency_ms: 0,
    });
  }
  {
    const start = Date.now();
    const apiKey = process.env.XAI_API_KEY;
    const xModel = apiKey ? await resolveXaiModel() : null;
    if (!apiKey) {
      results.push({ provider: 'xai', model: 'unresolved', status: 'no_key', latency_ms: 0 });
    } else if (!xModel) {
      results.push({ provider: 'xai', model: 'unresolved', status: 'exception', error: `каталог моделей недоступен: ${xaiResolveProblem() ?? 'причина не записана'}`, latency_ms: Date.now() - start });
    } else {
      try {
        // 60 с, а не 15: run 8 упёрся в таймаут на grok-4.6 — это флагман с
        // размышлением, и 15 с ему мало. Диагностике спешить некуда, а
        // «таймаут» вместо ответа снова оставил бы вопрос открытым.
        const res = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: xModel, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(60_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'xai', model: xModel, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'xai', model: xModel, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'xai', model: xModel, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 6b. xAI, вторая строка: САМАЯ ЛЁГКАЯ пригодная модель каталога.
  //     Флагман (grok-4.6) может не уложиться в бюджет ответа, и тогда по
  //     одной строке не отличить «провайдер мёртв» от «модель думает дольше
  //     нашего терпения». Лёгкая модель отвечает или нет — и это уже ответ.
  {
    const start = Date.now();
    const apiKey = process.env.XAI_API_KEY;
    if (apiKey) {
      const ids = classifyModels(await fetchModelIds('https://api.x.ai/v1/models', apiKey))
        .filter(m => m.eligible).map(m => m.id);
      const light = ids.find(id => /mini|fast|flash|lite|build/i.test(id)) ?? ids[ids.length - 1] ?? null;
      if (!light) {
        results.push({ provider: 'xai:light', model: 'unresolved', status: 'exception', error: `каталог пуст или непригоден: ${xaiResolveProblem() ?? 'причина не записана'}`, latency_ms: Date.now() - start });
      } else {
        try {
          const res = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: light, temperature: 0.4, max_tokens: 200, messages: payload }),
            signal: AbortSignal.timeout(30_000),
          });
          const ms = Date.now() - start;
          if (!res.ok) {
            results.push({ provider: 'xai:light', model: light, status: 'http_error', http_status: res.status, error: (await res.text().catch(() => '')).slice(0, 200), latency_ms: ms });
          } else {
            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content;
            results.push(text
              ? { provider: 'xai:light', model: light, status: 'success', answer_preview: text.slice(0, 100), latency_ms: ms }
              : { provider: 'xai:light', model: light, status: 'empty_response', error: describeEmptyCompletion(data), latency_ms: ms });
          }
        } catch (e) {
          results.push({ provider: 'xai:light', model: light, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
        }
      }
    }
  }

  // 7. Anthropic direct
  {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const systemMsg = messages.find(m => m.role === 'system');
        const turns = messages.filter(m => m.role !== 'system');
        const firstUserIdx = turns.findIndex(m => m.role === 'user');
        const clean = firstUserIdx >= 0 ? turns.slice(firstUserIdx) : turns;
        const anthropicMessages = clean.slice(-6).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const res = await relayFetch(`${ANTHROPIC_BASE}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL ?? 'claude-fable-5', max_tokens: 200, temperature: 0.4, ...(systemMsg ? { system: systemMsg.content } : {}), messages: anthropicMessages }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json() as Record<string, unknown>;
          const content = Array.isArray(data.content) ? data.content as Array<Record<string, unknown>> : [];
          const text = typeof content[0]?.text === 'string' ? content[0].text as string : undefined;
          results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'anthropic', model: 'claude-haiku-4.5', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 8. Sakana Fugu — primary-провайдер Editor-агента (A/B вариант B).
  // Форма запроса — как в callFugu: FUGU_BASE_URL нормализуется до /v1,
  // модель FUGU_MODEL, лимит через max_completion_tokens (не max_tokens).
  {
    const start = Date.now();
    const apiKey = getFuguKey();
    let base = (process.env.FUGU_BASE_URL || 'https://api.sakana.ai').replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base = `${base}/v1`;
    const model = process.env.FUGU_MODEL || 'fugu';
    if (!apiKey) {
      results.push({ provider: 'fugu', model, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, max_completion_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(45_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'fugu', model, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'fugu', model, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'fugu', model, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 9. GLM (ZhipuAI direct)
  {
    const start = Date.now();
    const apiKey = getGLMKey();
    if (!apiKey) {
      results.push({ provider: 'glm', model: 'glm-5.1', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'glm-5.1', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'glm', model: 'glm-5.1', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'glm', model: 'glm-5.1', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'glm', model: 'glm-5.1', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 10. NVIDIA NIM
  {
    const start = Date.now();
    const apiKey = getNvidiaKey();
    if (!apiKey) {
      results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'meta/llama-3.3-70b-instruct', temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 11. Groq (OpenAI-compatible, US — geo-проверка)
  {
    const start = Date.now();
    const apiKey = getGroqKey();
    if (!apiKey) {
      results.push({ provider: 'groq', model: GROQ_MODEL, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'groq', model: GROQ_MODEL, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'groq', model: GROQ_MODEL, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'groq', model: GROQ_MODEL, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 12. Cerebras (OpenAI-compatible, US — geo-проверка)
  {
    const start = Date.now();
    const apiKey = getCerebrasKey();
    if (!apiKey) {
      results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: CEREBRAS_MODEL, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'cerebras', model: CEREBRAS_MODEL, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // 13. Mistral La Plateforme (OpenAI-compatible, EU — geo-проверка)
  {
    const start = Date.now();
    const apiKey = getMistralKey();
    if (!apiKey) {
      results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: 'no_key', latency_ms: 0 });
    } else {
      try {
        const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: MISTRAL_MODEL, temperature: 0.4, max_tokens: 200, messages: payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: 'http_error', http_status: res.status, error: errText.slice(0, 200), latency_ms: ms });
        } else {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: text ? 'success' : 'empty_response', answer_preview: text?.slice(0, 100), latency_ms: ms });
        }
      } catch (e) {
        results.push({ provider: 'mistral', model: MISTRAL_MODEL, status: 'exception', error: String(e).slice(0, 200), latency_ms: Date.now() - start });
      }
    }
  }

  // Поправка к отказам, которые лгут о причине: xAI отвечает про ключ там, где
  // дело в адресе запроса (слова владельца 04.09). Ответ провайдера остаётся
  // дословным, заметка идёт рядом.
  for (const r of results) {
    const note = refusalNote(r.provider, r.http_status ?? null, r.error);
    if (note) r.note = note;
  }

  return results;
}
