/**
 * lib/ai/west-probe.ts — как нас видят ChatGPT (OpenAI) и Grok (xAI).
 *
 * Владелец 16.10: «как нас видят грок джипити чат». Ежемесячная проба знания
 * (app/api/cron/model-knowledge-probe) спрашивает модели С ПРОДА — DeepSeek,
 * Qwen, Kimi, GLM, YandexGPT. OpenAI и xAI с прода закрыты гео-блоком, поэтому
 * эта проба идёт С РАННЕРА GitHub через OpenRouter (ключ из секретов
 * репозитория, §8 «Два ключа»): scripts/west-knowledge-probe.ts,
 * .github/workflows/west-knowledge-probe.yml.
 *
 * Классификация ответов — та же, что у пробы с прода, и не копируется:
 * classifyAnswer / classifySearchAnswer / sourceDomains импортируются из её
 * роута. Вторая копия правил «знает / не знает» разошлась бы с первой, и два
 * замера одного вопроса перестали бы быть сравнимы.
 *
 * Четыре вопроса каждой модели:
 *   brand            — о сайте, без поиска (KNOWLEDGE_QUESTION_RU): веса;
 *   brand-search     — о сайте, с поиском (KNOWLEDGE_QUESTION_RU_SEARCH): выдача;
 *   topic-search-ru  — турист по теме, без нашего адреса и имени, по-русски;
 *   topic-search-en  — то же по-английски.
 * В вопросах о сайте нет слова «Камчатка» — край должна назвать модель; в
 * тематических край назван, «знает» там — назвала нас или нашла vedarai.ru.
 *
 * Исходы — четыре прежних (§4.0): knows / does_not_know / did_not_search /
 * could_not_ask. Отказ провайдера, таймаут, нет ключа, нет модели — всегда
 * could_not_ask с причиной, никогда «не знает».
 *
 * Модель не хардкодится (§8): сильнейшая общая модель вендора из каталога
 * OpenRouter (/api/v1/models), версия — flagshipVersion резолвера с поправкой
 * на двузначный минор (westVersion); маркер может задать модель явно. Сеть и ключ передаются параметрами — проба
 * проверяется на подменённом fetch, без единого запроса наружу.
 *
 * Поиск — плагин web OpenRouter с движком native (поиск самого провайдера:
 * у OpenAI и xAI он свой). Отказ 400 про движок или плагин — один повтор без
 * движка, и какой движок отработал, записывается. Источники — аннотации
 * url_citation ответа; счётчика поисков OpenRouter не отдаёт, поэтому
 * search_count всегда null, и «искала» судится только по источникам.
 *
 * Расход — строками для lib/ai/usage-sink (модель, токены, agent_id). Плата
 * OpenRouter за сам веб-поиск в эти строки не входит: приёмник считает цену
 * по токенам, и это сказано в выводе скрипта, а не подразумевается.
 *
 * Сторож: tests/unit/west-knowledge-probe.test.ts.
 */

import {
  KNOWLEDGE_QUESTION_RU,
  classifyAnswer,
  classifySearchAnswer,
  sourceDomains,
  type KnowledgeOutcome,
  type SearchMention,
} from '@/app/api/cron/model-knowledge-probe/route';
import { flagshipVersion } from '@/lib/ai/model-resolver';
import { openRouterAttribution } from '@/lib/ai/attribution';
import type { UsageRowToReport } from '@/lib/ai/usage-sink';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const OUR_DOMAIN = 'vedarai.ru';

/** Имя агента в книгах расхода (llm_usage_log.agent_id). */
export const WEST_AGENT_ID = 'west-knowledge-probe';

/** Потолок одного запроса; у поисковой ноги их может быть два (повтор без движка). */
export const WEST_CALL_TIMEOUT_MS = 90_000;
const CATALOG_TIMEOUT_MS = 30_000;
export const WEST_MAX_TOKENS = 900;
const TEMPERATURE = 0.2;
/**
 * Обе модели, которые каталог OpenRouter 16.10 называет сильнейшими
 * (gpt-6.1-sol, grok-4.7), — рассуждающие, и рассуждение съедает тот же
 * потолок max_tokens. При умолчании (medium) 900 токенов могли уйти на
 * рассуждение целиком, и ответ пришёл бы пустым — замер без ответа. Низкое
 * усилие оставляет потолок ответу; модель, которая параметра не знает,
 * его не получает (OpenRouter неподдерживаемые параметры отбрасывает).
 */
const REASONING = { effort: 'low' } as const;
const MAX_RESULTS = 8;
const EXCERPT = 300;
const BODY_EXCERPT = 300;

// ── Вопросы ─────────────────────────────────────────────────────────────

/**
 * Вопрос о сайте С ПОИСКОМ. Правила те же, что у KNOWLEDGE_QUESTION_RU: адрес
 * и имя есть, слова «Камчатка» и прежнего имени платформы нет — край должна
 * назвать выдача, а не подсказка.
 */
export const KNOWLEDGE_QUESTION_RU_SEARCH =
  'Можно искать в интернете. Что такое сайт vedarai.ru (платформа «Ведар» / Vedar)? '
  + 'Какому региону он посвящён и что предлагает? Если и после поиска ты не знаешь этот сайт, ответь просто: «не знаю».';

/**
 * Тематический вопрос туриста, который о нас не слышал: край назван, нашего
 * адреса и имени нет ни в каком написании.
 */
export const TOPIC_QUESTION_RU =
  'Собираюсь на Камчатку. На каких сайтах можно узнать реальные свободные места в групповых турах '
  + 'местных туроператоров и текущую вулканическую обстановку — безопасно ли сейчас идти к вулканам? '
  + 'Поищи в интернете и перечисли сайты: название и адрес.';

/** Тот же вопрос по-английски — так спросит турист вне России. */
export const TOPIC_QUESTION_EN =
  'I am planning a trip to Kamchatka. Which websites show real free seats in group tours of local tour operators '
  + 'and the current volcanic situation, i.e. whether it is safe to go to the volcanoes right now? '
  + 'Search the web and list the sites with their names and URLs.';

export type WestLegId = 'brand' | 'brand-search' | 'topic-search-ru' | 'topic-search-en';

export interface WestLegSpec {
  id: WestLegId;
  question: string;
  search: boolean;
  /** Что считать «знает» у поисковой ноги; у ноги без поиска — null. */
  mention: SearchMention | null;
  label: string;
}

export const WEST_LEGS: readonly WestLegSpec[] = [
  { id: 'brand', question: KNOWLEDGE_QUESTION_RU, search: false, mention: null, label: 'о сайте, без поиска' },
  { id: 'brand-search', question: KNOWLEDGE_QUESTION_RU_SEARCH, search: true, mention: 'region', label: 'о сайте, с поиском' },
  { id: 'topic-search-ru', question: TOPIC_QUESTION_RU, search: true, mention: 'brand', label: 'по теме, RU, с поиском' },
  { id: 'topic-search-en', question: TOPIC_QUESTION_EN, search: true, mention: 'brand', label: 'по теме, EN, с поиском' },
];

// ── Выбор модели ────────────────────────────────────────────────────────

export type WestVendor = 'openai' | 'xai';
export const WEST_VENDORS: readonly WestVendor[] = ['openai', 'xai'];

interface VendorRule {
  /** Префикс id в каталоге OpenRouter. */
  prefix: string;
  /**
   * Что не годится в «чат, который видит турист»: тяжёлые и облегчённые
   * тиры, узкие и служебные модели, рассуждающая линейка o*, превью.
   * Судится по имени после префикса.
   */
  exclude: RegExp;
  label: string;
}

export const WEST_VENDOR_RULES: Record<WestVendor, VendorRule> = {
  openai: {
    prefix: 'openai/',
    exclude: /(pro|max|ultra|mini|nano|oss|codex|deep-research|search|audio|realtime|image|embed|instruct|preview|o\d)/i,
    label: 'ChatGPT (OpenAI)',
  },
  xai: {
    prefix: 'x-ai/',
    exclude: /(mini|fast|code|vision|image|beta)/i,
    label: 'Grok (xAI)',
  },
};

/**
 * Версия для порядка: flagshipVersion резолвера с одной поправкой.
 *
 * Резолвер читает минор как одну цифру (`opus-4-5` → 4.5) и делит на десять
 * любой минор, поэтому двузначный минор через точку уходит в мажор:
 * `x-ai/grok-4.20` → 4 + 20/10 = 6.0, и сильнейшей становится Grok 4.20 —
 * модель старше 4.3, 4.5, 4.6 и 4.7 (каталог OpenRouter 16.10: 4.20 выложена
 * раньше всех четырёх). Через точку версия — десятичная дробь: 4.20 = 4.2.
 * Общий резолвер здесь не правится: им же выбирается флагман решателя
 * эволюции, и смена его порядка — отдельное решение.
 */
export function westVersion(id: string): number {
  const dotted = id.toLowerCase().match(/(?:gpt|grok)-(\d+)\.(\d{2})(?!\d)/);
  return dotted ? Number(`${dotted[1]}.${dotted[2]}`) : flagshipVersion(id);
}

/**
 * Сильнейшая модель вендора из списка id каталога, либо null.
 *
 * Порядок — westVersion (gpt-5.5 → 5.5, grok-4.6 → 4.6); при равной версии —
 * более короткий id (gpt-5.5 вперёд снимка gpt-5.5-2026-…), затем
 * лексикографически. Варианты через двоеточие (`:batch`, `:free`, `:online`)
 * — не отдельные модели, а режимы OpenRouter, и в выбор не идут.
 */
export function pickWestModel(ids: readonly string[], vendor: WestVendor): string | null {
  const rule = WEST_VENDOR_RULES[vendor];
  const cand = ids.filter((id) =>
    typeof id === 'string'
    && id.startsWith(rule.prefix)
    && id.length > rule.prefix.length
    && !id.includes(':')
    && !rule.exclude.test(id.slice(rule.prefix.length)));
  if (cand.length === 0) return null;
  return [...cand].sort((a, b) =>
    westVersion(b) - westVersion(a) || a.length - b.length || a.localeCompare(b))[0];
}

export type CatalogRead = { ok: true; ids: string[] } | { ok: false; reason: string };

export interface ModelChoice {
  vendor: WestVendor;
  model: string | null;
  /** Откуда модель: маркер или каталог; null — модели нет. */
  source: 'override' | 'catalog' | null;
  /** Почему модели нет; null — есть. */
  reason: string | null;
  /** Оговорка при выбранной модели (например, маркер назвал id, которого нет в каталоге). */
  note: string | null;
}

/** Модель каждого вендора: маркер сильнее каталога. */
export function chooseWestModels(
  catalog: CatalogRead,
  overrides: Partial<Record<WestVendor, string>> = {},
): Record<WestVendor, ModelChoice> {
  const out = {} as Record<WestVendor, ModelChoice>;
  for (const vendor of WEST_VENDORS) {
    const rule = WEST_VENDOR_RULES[vendor];
    const forced = overrides[vendor]?.trim();
    if (forced) {
      const missing = catalog.ok && !catalog.ids.includes(forced);
      out[vendor] = {
        vendor, model: forced, source: 'override', reason: null,
        note: missing ? 'в каталоге OpenRouter такого id нет — спрашиваем, как задано в маркере' : null,
      };
      continue;
    }
    if (!catalog.ok) {
      out[vendor] = { vendor, model: null, source: null, reason: `каталог OpenRouter не прочитан: ${catalog.reason}`, note: null };
      continue;
    }
    const model = pickWestModel(catalog.ids, vendor);
    if (model) {
      out[vendor] = { vendor, model, source: 'catalog', reason: null, note: null };
    } else {
      const ofVendor = catalog.ids.filter((id) => id.startsWith(rule.prefix)).length;
      out[vendor] = {
        vendor, model: null, source: null,
        reason: ofVendor
          ? `в каталоге OpenRouter ${ofVendor} id с префиксом ${rule.prefix}, подходящей общей модели среди них нет`
          : `в каталоге OpenRouter нет ни одного id с префиксом ${rule.prefix}`,
        note: null,
      };
    }
  }
  return out;
}

/** Модели из маркера: { "models": { "openai": "...", "xai": "..." } }. Не строка — не модель. */
export function markerOverrides(marker: unknown): { overrides: Partial<Record<WestVendor, string>>; problems: string[] } {
  const overrides: Partial<Record<WestVendor, string>> = {};
  const problems: string[] = [];
  if (marker === null || typeof marker !== 'object') return { overrides, problems };
  const models = (marker as { models?: unknown }).models;
  if (models === undefined) return { overrides, problems };
  if (models === null || typeof models !== 'object' || Array.isArray(models)) {
    problems.push('поле models в маркере — не объект; модели берутся из каталога');
    return { overrides, problems };
  }
  for (const vendor of WEST_VENDORS) {
    const v = (models as Record<string, unknown>)[vendor];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') overrides[vendor] = v.trim();
    else problems.push(`models.${vendor} в маркере — не строка; модель ${vendor} берётся из каталога`);
  }
  return { overrides, problems };
}

/** Каталог OpenRouter: список id. Пустой список — отказ, а не «моделей нет» (§4.0). */
export async function readOpenRouterCatalog(fetchImpl: typeof fetch, apiKey?: string): Promise<CatalogRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${OPENROUTER}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${body.slice(0, BODY_EXCERPT)}`.trim() };
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch (err) {
      return { ok: false, reason: `ответ не разобран как JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const list = (data as { data?: unknown })?.data;
    const ids = Array.isArray(list)
      ? list.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) return { ok: false, reason: 'каталог пуст или без поля data[].id' };
    return { ok: true, ids };
  } catch (err) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `таймаут ${CATALOG_TIMEOUT_MS / 1000} с`
        : `сеть: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Один вопрос одной модели ────────────────────────────────────────────

export interface WestCallDeps {
  fetchImpl: typeof fetch;
  apiKey: string | undefined;
  /** Потолок одного запроса; по умолчанию WEST_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface LegUsage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface WestLegResult {
  vendor: WestVendor;
  /** Модель, которую спросили; null — модели не нашлось. */
  model: string | null;
  /** Модель, которую назвал ответ OpenRouter; null — ответа нет или поле пустое. */
  answered_model: string | null;
  leg: WestLegId;
  search: boolean;
  outcome: KnowledgeOutcome;
  signal: string;
  old_brand: boolean;
  /** Для could_not_ask — почему; иначе null. */
  reason: string | null;
  /** Движок плагина web, который отработал; null — нога без поиска или до ответа не дошло. */
  engine: 'native' | 'default' | null;
  /** Почему движок не native (тело отказа 400); null — не понадобилось. */
  engine_note: string | null;
  /** Сколько источников вернул ответ — вместе с теми, где адрес не разобрать. */
  sources: number;
  domains: string[];
  ours_in_sources: boolean;
  /** OpenRouter счётчика поисков не отдаёт: всегда null, «искала» — по источникам. */
  search_count: null;
  answer_excerpt: string | null;
  latency_ms: number;
  /** Токены ответа для книг; null — ответа с usage не было. */
  usage: LegUsage | null;
}

type PostOutcome =
  | { kind: 'ok'; data: unknown }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'bad_json'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'network'; detail: string };

async function postChat(deps: WestCallDeps, body: Record<string, unknown>): Promise<PostOutcome> {
  const ms = deps.timeoutMs ?? WEST_CALL_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PostOutcome>((resolve) => {
    timer = setTimeout(() => {
      // Сначала исход, потом обрыв: оборванный запрос не должен успеть
      // назваться сетевой ошибкой раньше таймаута.
      resolve({ kind: 'timeout' });
      controller.abort();
    }, ms);
  });
  const request = (async (): Promise<PostOutcome> => {
    try {
      const res = await deps.fetchImpl(`${OPENROUTER}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${deps.apiKey ?? ''}`,
          ...openRouterAttribution('west knowledge probe'),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) return { kind: 'http', status: res.status, body: text };
      try {
        return { kind: 'ok', data: JSON.parse(text) as unknown };
      } catch (err) {
        return { kind: 'bad_json', detail: `${err instanceof Error ? err.message : String(err)}; тело: ${text.slice(0, BODY_EXCERPT)}` };
      }
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'network', detail: err instanceof Error ? err.message : String(err) };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const oneLine = (s: string, max = BODY_EXCERPT) => s.replace(/\s+/g, ' ').trim().slice(0, max);

function failureReason(r: Exclude<PostOutcome, { kind: 'ok' }>, timeoutMs: number): string {
  switch (r.kind) {
    case 'http': return `HTTP ${r.status}: ${oneLine(r.body) || 'тело пустое'}`;
    case 'bad_json': return `ответ 200 не разобран как JSON: ${oneLine(r.detail)}`;
    case 'timeout': return timeoutMs >= 1000 ? `таймаут ${Math.round(timeoutMs / 1000)} с` : `таймаут ${timeoutMs} мс`;
    case 'network': return `сеть: ${oneLine(r.detail)}`;
  }
}

interface ParsedAnswer {
  text: string;
  sources: Array<{ url: string }>;
  finishReason: string | null;
  answeredModel: string | null;
  usage: LegUsage | null;
  reasoningTokens: number | null;
  bodyError: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function parseAnswer(data: unknown, requested: string): ParsedAnswer {
  const d = (data ?? {}) as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown; annotations?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
    error?: { message?: unknown; code?: unknown };
  };
  const choice = Array.isArray(d.choices) ? d.choices[0] : undefined;
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : '';
  const annotations = Array.isArray(choice?.message?.annotations) ? choice.message.annotations as unknown[] : [];
  // Форма OpenRouter: { type: 'url_citation', url_citation: { url, title, … } };
  // плоский { type, url } тоже принимается. Аннотация без адреса остаётся
  // источником с пустым url — classifySearchAnswer назовёт её неразобранной,
  // а не выбросит молча.
  const sources = annotations
    .filter((a) => (a as { type?: unknown })?.type === 'url_citation')
    .map((a) => {
      const nested = (a as { url_citation?: { url?: unknown } }).url_citation?.url;
      const flat = (a as { url?: unknown }).url;
      const url = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : '';
      return { url };
    });
  const answeredModel = typeof d.model === 'string' && d.model.trim() ? d.model.trim() : null;
  const prompt = num(d.usage?.prompt_tokens);
  const completion = num(d.usage?.completion_tokens);
  const usage = prompt !== null && completion !== null && prompt + completion > 0
    ? { model: answeredModel ?? requested, prompt_tokens: prompt, completion_tokens: completion }
    : null;
  const bodyError = d.error && !choice
    ? oneLine(`${typeof d.error.code === 'number' || typeof d.error.code === 'string' ? `${d.error.code} ` : ''}${typeof d.error.message === 'string' ? d.error.message : 'ошибка без текста'}`)
    : null;
  return {
    text,
    sources,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    answeredModel,
    usage,
    reasoningTokens: num(d.usage?.completion_tokens_details?.reasoning_tokens),
    bodyError,
  };
}

const isOurDomain = (d: string): boolean => d === OUR_DOMAIN || d.endsWith(`.${OUR_DOMAIN}`);

/** Отказ в плагине или движке: только на него повтор без движка. */
const ENGINE_REFUSAL = /engine|plugin/i;

/**
 * Один вопрос одной модели. Никогда не бросает: любой отказ — could_not_ask
 * с причиной (§4.0).
 */
export async function askWestLeg(
  vendor: WestVendor,
  model: string | null,
  leg: WestLegSpec,
  deps: WestCallDeps,
  modelReason: string | null = null,
): Promise<WestLegResult> {
  const started = Date.now();
  const timeoutMs = deps.timeoutMs ?? WEST_CALL_TIMEOUT_MS;
  const base = {
    vendor, model, answered_model: null, leg: leg.id, search: leg.search,
    old_brand: false, engine: null, engine_note: null, sources: 0, domains: [] as string[],
    ours_in_sources: false, search_count: null, answer_excerpt: null, usage: null,
  } satisfies Partial<WestLegResult>;
  const notAsked = (reason: string, extra: Partial<WestLegResult> = {}): WestLegResult => ({
    ...base, outcome: 'could_not_ask', signal: 'спросить не удалось', reason,
    latency_ms: Date.now() - started, ...extra,
  });

  if (!deps.apiKey) return notAsked('OPENROUTER_API_KEY не задан — спросить нечем');
  if (!model) return notAsked(modelReason ?? 'модель не выбрана');

  const body = (plugin: Record<string, unknown> | null): Record<string, unknown> => ({
    model,
    messages: [{ role: 'user', content: leg.question }],
    max_tokens: WEST_MAX_TOKENS,
    temperature: TEMPERATURE,
    reasoning: REASONING,
    ...(plugin ? { plugins: [plugin] } : {}),
  });

  let engine: 'native' | 'default' | null = null;
  let engineNote: string | null = null;
  let r: PostOutcome;
  if (leg.search) {
    engine = 'native';
    r = await postChat(deps, body({ id: 'web', engine: 'native', max_results: MAX_RESULTS }));
    if (r.kind === 'http' && r.status === 400 && ENGINE_REFUSAL.test(r.body)) {
      engine = 'default';
      engineNote = `движок native отклонён: HTTP 400 ${oneLine(r.body, 200)}`;
      r = await postChat(deps, body({ id: 'web', max_results: MAX_RESULTS }));
    }
  } else {
    r = await postChat(deps, body(null));
  }

  if (r.kind !== 'ok') {
    const why = failureReason(r, timeoutMs);
    return notAsked(engineNote ? `${why}; ${engineNote}` : why, { engine: null, engine_note: engineNote });
  }

  const a = parseAnswer(r.data, model);
  const common = {
    answered_model: a.answeredModel,
    engine,
    engine_note: engineNote,
    usage: a.usage,
    answer_excerpt: a.text.trim() ? a.text.trim().slice(0, EXCERPT) : null,
  };
  if (a.bodyError) return notAsked(`ошибка в теле ответа 200: ${a.bodyError}`, common);

  const domains = sourceDomains(a.sources.map((s) => s.url));
  const traced = {
    ...common,
    sources: a.sources.length,
    domains,
    ours_in_sources: domains.some(isOurDomain),
  };
  const classified = leg.search && leg.mention
    ? classifySearchAnswer({ text: a.text, search_count: null, sources: a.sources }, leg.mention)
    : classifyAnswer(a.text);
  let reason: string | null = null;
  if (classified.outcome === 'could_not_ask') {
    // Пустой текст при 200 — частый случай у рассуждающих моделей: потолок
    // токенов ушёл на рассуждение. Называется, а не выдаётся за «не знает».
    const reasoning = a.reasoningTokens !== null ? `, на рассуждение ушло ${a.reasoningTokens} из ${WEST_MAX_TOKENS} токенов` : '';
    reason = `ответ пустой: finish_reason ${a.finishReason ?? 'не назван'}${reasoning}`;
  }
  return {
    ...base,
    ...traced,
    outcome: classified.outcome,
    signal: classified.signal,
    old_brand: classified.old_brand,
    reason,
    latency_ms: Date.now() - started,
  };
}

// ── Весь прогон ─────────────────────────────────────────────────────────

/** Код выхода: 1 — только когда спросить не удалось НИКОГО (ноль ответов на ненулевом входе, §4.0). */
export function westProbeExitCode(legs: readonly Pick<WestLegResult, 'outcome'>[]): 0 | 1 {
  if (legs.length === 0) return 1;
  return legs.every((l) => l.outcome === 'could_not_ask') ? 1 : 0;
}

export interface WestProbeDeps extends WestCallDeps {
  overrides?: Partial<Record<WestVendor, string>>;
  now?: () => Date;
}

export interface WestProbeReport {
  ok: boolean;
  error: string | null;
  exit_code: 0 | 1;
  asked_at: string;
  catalog: { ok: boolean; ids: number | null; reason: string | null };
  models: Record<WestVendor, ModelChoice>;
  questions: Record<WestLegId, string>;
  legs: WestLegResult[];
  /** Исход → «вендор/нога». */
  summary: Record<KnowledgeOutcome, string[]>;
  /** Строки для lib/ai/usage-sink: только ответы, где провайдер назвал токены. */
  usage_rows: UsageRowToReport[];
}

export async function runWestProbe(deps: WestProbeDeps): Promise<WestProbeReport> {
  const askedAt = (deps.now ? deps.now() : new Date()).toISOString();
  const catalog = await readOpenRouterCatalog(deps.fetchImpl, deps.apiKey);
  const models = chooseWestModels(catalog, deps.overrides ?? {});

  const plan = WEST_VENDORS.flatMap((vendor) => WEST_LEGS.map((leg) => ({ vendor, leg })));
  const legs = await Promise.all(plan.map(({ vendor, leg }) =>
    askWestLeg(vendor, models[vendor].model, leg, deps, models[vendor].reason)));

  const summary: Record<KnowledgeOutcome, string[]> = { knows: [], does_not_know: [], did_not_search: [], could_not_ask: [] };
  for (const l of legs) summary[l.outcome].push(`${l.vendor}/${l.leg}`);

  const usage_rows: UsageRowToReport[] = legs.flatMap((l) => (l.usage
    ? [{ model: l.usage.model, prompt_tokens: l.usage.prompt_tokens, completion_tokens: l.usage.completion_tokens, agent_id: WEST_AGENT_ID }]
    : []));

  const exit_code = westProbeExitCode(legs);
  return {
    ok: exit_code === 0,
    error: exit_code === 0 ? null : 'ни одну модель спросить не удалось — замера нет',
    exit_code,
    asked_at: askedAt,
    catalog: catalog.ok
      ? { ok: true, ids: catalog.ids.length, reason: null }
      : { ok: false, ids: null, reason: catalog.reason },
    models,
    questions: Object.fromEntries(WEST_LEGS.map((l) => [l.id, l.question])) as Record<WestLegId, string>,
    legs,
    summary,
    usage_rows,
  };
}

// ── Вывод ───────────────────────────────────────────────────────────────

export const OUTCOME_WORDS: Record<KnowledgeOutcome, string> = {
  knows: 'знает',
  does_not_know: 'не знает',
  did_not_search: 'не искала или выдачи нет («нас нет» не измерено)',
  could_not_ask: 'спросить не удалось',
};

const legLabel = (id: WestLegId): string => WEST_LEGS.find((l) => l.id === id)?.label ?? id;

/** Строка лога одной ноги. */
export function formatLegLine(l: WestLegResult): string {
  const parts = [
    l.vendor,
    l.model ?? 'модели нет',
    l.leg,
    l.outcome,
    l.reason ? `${l.signal}: ${l.reason}` : l.signal,
    `доменов в источниках: ${l.domains.length}`,
    `${OUR_DOMAIN} среди источников: ${l.ours_in_sources ? 'да' : 'нет'}`,
  ];
  if (l.search) parts.push(`движок поиска: ${l.engine ?? '—'}${l.engine_note ? ` (${l.engine_note})` : ''}`);
  parts.push(l.answer_excerpt ? `«${oneLine(l.answer_excerpt, EXCERPT)}»` : 'ответа нет');
  return parts.join(' · ');
}

const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** Сводка прогона для $GITHUB_STEP_SUMMARY (markdown). */
export function renderWestSummary(report: WestProbeReport): string {
  const lines: string[] = [
    '## Как нас видят ChatGPT и Grok — проба с раннера через OpenRouter',
    '',
    `Спрошено: ${report.asked_at}. Каталог OpenRouter: ${report.catalog.ok ? `прочитан, id: ${report.catalog.ids}` : `не прочитан — ${report.catalog.reason}`}.`,
    '',
  ];
  for (const vendor of WEST_VENDORS) {
    const m = report.models[vendor];
    const what = m.model
      ? `${m.model} (${m.source === 'override' ? 'из маркера' : 'сильнейшая из каталога'}${m.note ? `; ${m.note}` : ''})`
      : `модели нет — ${m.reason ?? 'причина не названа'}`;
    lines.push(`- ${WEST_VENDOR_RULES[vendor].label}: ${cell(what)}`);
  }
  lines.push(
    '',
    '| Модель | Вопрос | Исход | Сигнал / причина | Поиск | Доменов | vedarai.ru в источниках | Ответ (до 300 знаков) |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const l of report.legs) {
    const search = l.search ? `${l.engine ?? '—'}${l.engine_note ? ` (${l.engine_note})` : ''}` : 'без поиска';
    lines.push(`| ${cell(`${l.vendor}: ${l.model ?? '—'}`)} | ${cell(legLabel(l.leg))} | ${cell(OUTCOME_WORDS[l.outcome])} | ${cell(l.reason ? `${l.signal}: ${l.reason}` : l.signal)} | ${cell(search)} | ${l.domains.length} | ${l.ours_in_sources ? 'да' : 'нет'} | ${cell(l.answer_excerpt ?? '—')} |`);
  }
  lines.push(
    '',
    'В вопросах о сайте нет слова «Камчатка»: «знает» — модель назвала край сама. '
      + 'В тематических вопросах край назван, нашего адреса и имени нет: «знает» там — назвала нас или нашла vedarai.ru среди источников. '
      + 'OpenRouter счётчика поисков не отдаёт: «искала» судится только по источникам.',
  );
  if (!report.ok) lines.push('', `**Замера нет:** ${report.error}`);
  return `${lines.join('\n')}\n`;
}
