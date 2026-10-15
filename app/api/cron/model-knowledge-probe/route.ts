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
 * Три исхода (§4.0), и третий не равен второму (у поисковых ног есть
 * четвёртый — did_not_search, ниже):
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
 * Пятая нога — Qwen со встроенным поиском DashScope (13.10): веса и выдача
 * поиска — два разных «знает», и вопрос ей задаётся отдельный
 * (KNOWLEDGE_QUESTION_SEARCH), тоже без слова «Камчатка». Остальные
 * провайдеры поиск параметром не включают, у них одна нога.
 *
 * С 15.10 (аудит, находка CN-probe) поиск принудительный и с источниками
 * (callQwenSearch: forced_search + enable_source нативного протокола
 * DashScope). До этого модель сама решала, искать ли, источников не было, и
 * «не знает» не отличало «не искала» от «искала, нас нет». Теперь у поисковых
 * ног четвёртый исход — did_not_search: ответ пришёл, а выдачи в нём нет
 * (шлюз не вернул ни одного источника), то есть «нас нет» из этого не
 * следует. Счётчик usage.plugins.search.count доказательством поиска не
 * считается (аудит 15.10, находка R-probe): документация называет его
 * отметкой этапа распознавания намерения, а при forced_search он почти
 * всегда больше нуля. «Счётчик есть, источников нет» — тоже did_not_search,
 * со своим сигналом «намерение поиска было, выдачи шлюз не вернул», а не
 * «искала, нас нет». Домены источников идут в сводку и итог владельцу.
 *
 * Седьмая нога — qwen-search-topic (15.10): турист в Китае ищет по теме, а не
 * по нашему адресу. Вопрос (KNOWLEDGE_QUESTION_TOPIC) — о сайтах с местами в
 * группах и вулканической обстановкой на Камчатке, без домена и без имени
 * платформы; «знает» — ответ упомянул vedarai / Ведар / Vedar / 维达尔 (или
 * прежнее имя) либо vedarai.ru стоит среди источников выдачи.
 *
 * Шестая нога — YandexGPT (13.10, владелец: «остались российские ИИ»):
 * единственный домашний сток (provider-registry, РФ), спрашивается на своём
 * языке (KNOWLEDGE_QUESTION_RU) по тем же правилам: без слова «Камчатка» и без
 * прежнего имени. Модель — как в обёртке callYandexGPT, id здесь не называется.
 *
 * Повторять раз в месяц: единственный честный способ увидеть, изменилось ли
 * что-то после китайского слоя и регистраций. Запускает
 * model-knowledge-probe.yml — по маркеру .github/triggers/model-knowledge-probe.json
 * и, с 14.10 (владелец: «включай»), по расписанию раз в месяц.
 *
 * ?notify=1 — итог в админский чат Telegram, туда же, куда тревоги Watchdog
 * (tgSend, TELEGRAM_CHAT_ID). Без него ежемесячный замер лежал бы
 * в сводке прогона GitHub Actions, куда никто не заходит, и момент «модель
 * нас узнала», ради которого проба повторяется, прошёл бы мимо (§10.09: у
 * результата должен быть потребитель). Доставку tgSend возвращает исходом,
 * «не ушло» видно в ответе. Пульс — agent_run_history под 'model-knowledge-probe':
 * прогон, где спросить не удалось никого, пишется 'failed', а не тишиной.
 * Сторожа: tests/unit/agents-china-layer.test.ts,
 * tests/unit/model-knowledge-probe-notify.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { callDeepSeek, callQwen, callQwenSearch, callKimi, callGLM, callYandexGPT, resolveChatModel, type QwenSearchResult } from '@/lib/ai/providers';
import { recentAiFailures } from '@/lib/ai/failure-trace';
import { runPlace } from '@/lib/ai/key-identity';
import type { ChatMessage } from '@/lib/ai/prompts';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * did_not_search — только у поисковых ног: ответ есть, выдачи нет — шлюз не
 * вернул ни одного источника (счётчика либо нет, либо он лишь отметка
 * намерения). Не равен does_not_know: «нас там нет» не измерено.
 */
export type KnowledgeOutcome = 'knows' | 'does_not_know' | 'did_not_search' | 'could_not_ask';

/** Вопрос без слова «Камчатка» и без прежнего имени: только домен и имя. */
export const KNOWLEDGE_QUESTION =
  '请只根据你训练时已有的知识回答，不要联网搜索。网站 vedarai.ru（平台名 Ведар / Vedar）是什么？'
  + '它服务于哪个地区，提供什么？如果你不了解这个网站，请直接回答“不知道”。';

/**
 * Та же проба С ПОИСКОМ (13.10, карт-бланш владельца «подключи китайские
 * модели»). Веса и выдача поиска — два разных «знает»: в веса не
 * записаться, а что находит поиск Alibaba (Quark/Shenma) по нашему адресу —
 * ровно то, чем китайский чат ответит туристу сегодня. Слова «Камчатка» в
 * вопросе по-прежнему нет: назвать край должна выдача, а не подсказка.
 */
export const KNOWLEDGE_QUESTION_SEARCH =
  '可以联网搜索。网站 vedarai.ru（平台名 Ведар / Vedar）是什么？'
  + '它服务于哪个地区，提供什么？如果搜索后仍不了解这个网站，请直接回答“不知道”。';

/**
 * Тематический вопрос туриста из КНР (15.10, аудит CN-probe): без нашего
 * адреса и без имени платформы ни в каком написании — так спрашивают, когда
 * о нас ещё не слышали. Край назван: искать надо по теме. «Знает» здесь —
 * поиск привёл к нам сам (имя в ответе или vedarai.ru среди источников).
 */
export const KNOWLEDGE_QUESTION_TOPIC =
  '堪察加旅游：哪些网站可以查到当地旅行社团队游的真实余位和火山安全信息？'
  + '请联网搜索后回答，并列出网站名称和网址。';

/**
 * Вопрос по-русски для российской ноги (13.10): YandexGPT спрашивается на
 * своём языке. Правила те же, что у китайского вопроса: домен и имя есть,
 * слова «Камчатка» и прежнего имени платформы нет — назвать край модель
 * должна сама.
 */
export const KNOWLEDGE_QUESTION_RU =
  'Отвечай только по своим знаниям, без поиска в интернете. Что такое сайт vedarai.ru (платформа «Ведар» / Vedar)? '
  + 'Какому региону он посвящён и что предлагает? Если ты не знаешь этот сайт, ответь просто: «не знаю».';

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

/**
 * Наше имя в ответе на тематический вопрос: адрес, латиница, кириллица,
 * китайское имя из разметки организации (#2483). `\bvedar\b` — чтобы не
 * поймать постороннее слово, в которое «vedar» входит частью.
 */
const BRAND_RE = /vedarai|\bvedar\b|ведар|维达尔/i;
const OUR_DOMAIN = 'vedarai.ru';

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

/** След поиска в ответе: что шлюз сказал о поиске сам, без догадок. */
export interface SearchTrace {
  /**
   * Шлюз вернул источники — единственное доказательство, что выдачу спросили.
   * Счётчик сюда не входит (аудит 15.10, R-probe): он отметка намерения.
   */
  searched: boolean;
  /**
   * usage.plugins.search.count — отметка этапа распознавания намерения, а не
   * число выполненных поисков; null — шлюз счётчика не прислал.
   */
  count: number | null;
  /** Сколько источников вернул шлюз — вместе с теми, где адрес не разобрать. */
  sources: number;
  /** Домены источников по порядку выдачи, без повторов и без www. */
  domains: string[];
}

/**
 * Адреса источников → домены. Не адрес — пропускается: домена у него нет, а
 * сам источник остаётся в счёте `SearchTrace.sources`, так что пропуск виден.
 */
export function sourceDomains(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    host = host.replace(/^www\./, '');
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

const isOurDomain = (d: string): boolean => d === OUR_DOMAIN || d.endsWith(`.${OUR_DOMAIN}`);

/**
 * Что считать «знает» у поисковой ноги:
 *   region — вопрос о нашем адресе без названия края: знает, если ответ
 *            назвал край (или прежнее имя) — как у ног без поиска;
 *   brand  — тематический вопрос, край назван в нём самом: знает, если ответ
 *            назвал нас.
 * Источник vedarai.ru в выдаче — «знает» у обеих: поиск нашёл сайт.
 */
export type SearchMention = 'region' | 'brand';

export interface SearchClassified extends Classified {
  search: SearchTrace;
}

/**
 * Ответ поисковой ноги → исход. «Знает» побеждает всегда (назвала нас — значит
 * знает, откуда бы ни взяла). Иначе решают источники: есть — «искала, нас
 * нет»; нет — «не искала» (или «намерение было, выдачи нет», если шлюз
 * прислал только счётчик), и это не «нас нет» (§4.0).
 */
export function classifySearchAnswer(
  answer: { text: string; search_count: number | null; sources: ReadonlyArray<{ url: string }> },
  mention: SearchMention,
): SearchClassified {
  const text = answer.text.trim();
  const domains = sourceDomains(answer.sources.map((s) => s.url));
  const count = answer.search_count;
  const search: SearchTrace = {
    // Аудит 15.10, находка R-probe: «искала» — только по источникам. Прежде
    // хватало счётчика, и ответ без единого источника при count = 1 уходил
    // владельцу строкой «Не знают», хотя выдачи никто не видел.
    searched: answer.sources.length > 0,
    count,
    sources: answer.sources.length,
    domains,
  };
  if (!text) return { outcome: 'could_not_ask', signal: 'ответа нет', old_brand: false, search };
  const oldBrand = OLD_BRAND_RE.test(text);
  // Счётчик без источников: намерение поиска было, выдачи шлюз не вернул.
  const intentOnly = !search.searched && (count ?? 0) > 0;
  const viaSearch = search.searched
    ? ''
    : intentOnly
      ? ' (источников в ответе нет, есть только отметка намерения поиска — из весов или из выдачи, не различить)'
      : ' (следа поиска в ответе нет — из весов, а не из выдачи)';

  if (domains.some(isOurDomain)) {
    return { outcome: 'knows', signal: `поиск нашёл ${OUR_DOMAIN} среди источников`, old_brand: oldBrand, search };
  }
  if (mention === 'region') {
    const base = classifyAnswer(text);
    if (base.outcome === 'knows') return { ...base, signal: `${base.signal}${viaSearch}`, search };
  } else {
    if (BRAND_RE.test(text)) {
      return { outcome: 'knows', signal: `упомянула нас в ответе (vedarai / Ведар / Vedar / 维达尔)${viaSearch}`, old_brand: oldBrand, search };
    }
    if (oldBrand) {
      return { outcome: 'knows', signal: `упомянула прежнее имя платформы${viaSearch}`, old_brand: true, search };
    }
  }
  if (!search.searched) {
    return {
      outcome: 'did_not_search',
      signal: intentOnly
        ? `намерение поиска было, выдачи шлюз не вернул: счётчик ${count}, источников нет — «нас нет» не измерено`
        : 'не искала: в ответе нет ни источников, ни счётчика поиска — выдачу не спросили, «нас нет» не измерено',
      old_brand: false,
      search,
    };
  }
  return {
    outcome: 'does_not_know',
    signal: `искала, нас нет: источников ${search.sources}, ${OUR_DOMAIN} среди них нет`,
    old_brand: false,
    search,
  };
}

export type ProbeProvider = 'deepseek' | 'qwen' | 'qwen-search' | 'qwen-search-topic' | 'kimi' | 'glm' | 'yandex';

interface LegBase {
  provider: ProbeProvider;
  keyEnv: string;
  model: () => Promise<string | null>;
  /** Вопрос ноги; по умолчанию — без поиска. */
  question?: string;
}

/** Нога без поиска: обёртка отдаёт текст или null, причина — в следе отказов. */
interface PlainLeg extends LegBase {
  kind: 'plain';
  call: (messages: ChatMessage[]) => Promise<string | null>;
  /** Метка провайдера в следе отказов; null — обёртка следа не пишет. */
  traceLabel: string | null;
}

/** Нога с поиском: ответ несёт след поиска, отказ — причину прямо в результате. */
interface SearchLeg extends LegBase {
  kind: 'search';
  search: (messages: ChatMessage[]) => Promise<QwenSearchResult>;
  mention: SearchMention;
}

type ProbeLeg = PlainLeg | SearchLeg;

const LEGS: readonly ProbeLeg[] = [
  {
    kind: 'plain', provider: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', traceLabel: 'deepseek',
    call: (m) => callDeepSeek(m, { maxTokens: 300, timeoutMs: 45_000 }),
    model: () => resolveChatModel('deepseek'),
  },
  {
    kind: 'plain', provider: 'qwen', keyEnv: 'DASHSCOPE_API_KEY', traceLabel: 'qwen',
    call: (m) => callQwen(m, { maxTokens: 300 }),
    model: () => resolveChatModel('qwen'),
  },
  {
    // Qwen со встроенным поиском DashScope: единственная из четырёх, у кого
    // поиск включается параметром API. Платная функция без бесплатной
    // квоты — в режиме «только бесплатная квота» (решение владельца 25.09)
    // провайдер может отказать; тогда исход «спросить не удалось» с причиной
    // из результата вызова, а не «не нашла» (§4.0). Поиск принудительный,
    // с источниками (15.10, CN-probe).
    kind: 'search', provider: 'qwen-search', keyEnv: 'DASHSCOPE_API_KEY', mention: 'region',
    search: (m) => callQwenSearch(m, { maxTokens: 300 }),
    model: () => resolveChatModel('qwen'),
    question: KNOWLEDGE_QUESTION_SEARCH,
  },
  {
    // Тот же поиск, тематический вопрос без домена (15.10, CN-probe): найдёт
    // ли нас турист, который о нас не слышал. 600 токенов — ответ со списком
    // сайтов длиннее ответа «что это за домен».
    kind: 'search', provider: 'qwen-search-topic', keyEnv: 'DASHSCOPE_API_KEY', mention: 'brand',
    search: (m) => callQwenSearch(m, { maxTokens: 600 }),
    model: () => resolveChatModel('qwen'),
    question: KNOWLEDGE_QUESTION_TOPIC,
  },
  {
    kind: 'plain', provider: 'kimi', keyEnv: 'MOONSHOT_API_KEY', traceLabel: 'kimi',
    call: (m) => callKimi(m, { maxTokens: 300, timeoutMs: 45_000 }),
    model: async () => process.env.MOONSHOT_MODEL ?? null,
  },
  {
    kind: 'plain', provider: 'glm', keyEnv: 'GLM_API_KEY', traceLabel: null,
    call: (m) => callGLM(m),
    model: async () => null,
  },
  {
    // Российская нога (13.10): YandexGPT, домашний сток. Вопрос по-русски;
    // обёртка не отдаёт имени модели, а в след отказов пишет (label 'yandex').
    kind: 'plain', provider: 'yandex', keyEnv: 'YANDEX_API_KEY', traceLabel: 'yandex',
    call: (m) => callYandexGPT(m),
    model: async () => null,
    question: KNOWLEDGE_QUESTION_RU,
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
  /** След поиска — только у поисковых ног, когда ответ пришёл; иначе null. */
  search: SearchTrace | null;
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
      reason: `${leg.keyEnv} не задан — спросить нечем`, latency_ms: 0, answer_excerpt: null, search: null,
    };
  }
  const messages: ChatMessage[] = [{ role: 'user', content: leg.question ?? KNOWLEDGE_QUESTION }];
  const timedOut = (latency: number): LegResult => ({
    provider: leg.provider, model, outcome: 'could_not_ask', signal: 'ответа нет', old_brand: false,
    reason: `таймаут ${LEG_TIMEOUT_MS / 1000} с`, latency_ms: latency, answer_excerpt: null, search: null,
  });

  if (leg.kind === 'search') {
    const result = await withTimeout(leg.search(messages).catch((err: unknown): QwenSearchResult => {
      console.error(`[model-knowledge-probe] ${leg.provider}: обёртка бросила:`, err instanceof Error ? err.message : err);
      return { ok: false, reason: `обёртка бросила: ${err instanceof Error ? err.message : String(err)}`, model: null };
    }), LEG_TIMEOUT_MS);
    const latency = Date.now() - started;
    if (result === 'timeout') return timedOut(latency);
    const used = result.model ?? model;
    if (!result.ok) {
      return {
        provider: leg.provider, model: used, outcome: 'could_not_ask', signal: 'спросить не удалось', old_brand: false,
        reason: result.reason, latency_ms: latency, answer_excerpt: null, search: null,
      };
    }
    const { outcome, signal, old_brand, search } = classifySearchAnswer(result, leg.mention);
    return {
      provider: leg.provider, model: used, outcome, signal, old_brand,
      reason: outcome === 'could_not_ask' ? 'ответ пустой' : null,
      latency_ms: latency, answer_excerpt: result.text.trim().slice(0, ANSWER_EXCERPT), search,
    };
  }

  const answer = await withTimeout(leg.call(messages).catch((err: unknown) => {
    console.error(`[model-knowledge-probe] ${leg.provider}: обёртка бросила:`, err instanceof Error ? err.message : err);
    return null;
  }), LEG_TIMEOUT_MS);
  const latency = Date.now() - started;
  if (answer === 'timeout') return timedOut(latency);
  const { outcome, signal, old_brand } = classifyAnswer(answer);
  let reason: string | null = null;
  if (outcome === 'could_not_ask') {
    reason = leg.traceLabel
      ? (lastFailure(leg.traceLabel, started) ?? 'обёртка вернула null, в следе отказов причины нет')
      : 'обёртка вернула null; callGLM след отказов не пишет — причина не записана';
  }
  return {
    provider: leg.provider, model, outcome, signal, old_brand, reason, latency_ms: latency,
    answer_excerpt: answer ? answer.trim().slice(0, ANSWER_EXCERPT) : null, search: null,
  };
}

export interface Summary extends Record<KnowledgeOutcome, string[]> {
  /** Кто назвал прежнее имя платформы — знает нас под старым брендом. */
  old_brand: string[];
  /** Домены источников у поисковых ног, где ответ пришёл: нога → домены. */
  sources: Record<string, string[]>;
}

export function summarize(legs: readonly LegResult[]): Summary {
  const s: Summary = { knows: [], does_not_know: [], did_not_search: [], could_not_ask: [], old_brand: [], sources: {} };
  for (const l of legs) {
    s[l.outcome].push(l.provider);
    if (l.old_brand) s.old_brand.push(l.provider);
    if (l.search) s.sources[l.provider] = l.search.domains;
  }
  return s;
}

/** Имя агента в agent_run_history и метка в логе — то же, что в реестре кронов. */
const SCOPE = 'model-knowledge-probe';
const DIGEST_EXCERPT = 200;
const DIGEST_REASON = 160;
/** Сколько доменов источника показать в итоге: дальше — числом. */
const DIGEST_DOMAINS = 8;

/**
 * Итог пробы владельцу (Telegram, HTML). Всё, что пришло от моделей и
 * провайдеров, — ответ, имя модели, причина отказа — через escapeHtml: чужой
 * текст с `<` иначе сломал бы разметку, и Telegram отверг бы сообщение целиком.
 * «Знают» идёт первым и с цитатой: ради этой строки проба и повторяется.
 */
export function digestText(legs: readonly LegResult[], summary: Summary): string {
  const named = (l: LegResult) => escapeHtml(l.model ? `${l.provider} (${l.model})` : l.provider);
  const of = (outcome: KnowledgeOutcome) => legs.filter((l) => l.outcome === outcome);
  const lines = ['<b>Знают ли модели о Ведаре</b> — проба с прода', ''];

  const knows = of('knows');
  if (knows.length) {
    lines.push(`<b>Знают: ${knows.map(named).join(', ')}</b>`);
    for (const l of knows) {
      const quote = l.answer_excerpt ? ` — «${escapeHtml(l.answer_excerpt.slice(0, DIGEST_EXCERPT))}»` : '';
      lines.push(`${escapeHtml(l.provider)}: ${escapeHtml(l.signal)}${quote}`);
    }
  } else {
    lines.push('Знают: никто');
  }
  const unknown = of('does_not_know');
  lines.push(`Не знают: ${unknown.length ? unknown.map(named).join(', ') : '—'}`);
  // Аудит 15.10, R-probe: у каждой ноги своя причина — «не искала» и
  // «намерение было, выдачи нет» владелец должен различать, и ни то ни другое
  // не читается как «не знают».
  const noSearch = of('did_not_search');
  if (noSearch.length) {
    lines.push(`Не искали или выдачи нет («нас нет» не измерено): ${noSearch.map(named).join(', ')}`);
    for (const l of noSearch) {
      lines.push(`${escapeHtml(l.provider)}: ${escapeHtml(l.signal.slice(0, DIGEST_REASON))}`);
    }
  }
  const notAsked = of('could_not_ask');
  if (notAsked.length) {
    lines.push('Спросить не удалось:');
    for (const l of notAsked) {
      lines.push(`${escapeHtml(l.provider)}: ${escapeHtml((l.reason ?? 'причина не записана').slice(0, DIGEST_REASON))}`);
    }
  }
  if (summary.old_brand.length) {
    lines.push(`Под прежним именем платформы: ${escapeHtml(summary.old_brand.join(', '))}`);
  }
  const traced = legs.flatMap((l) => (l.search ? [{ provider: l.provider, trace: l.search }] : []));
  if (traced.length) {
    lines.push('Источники поиска:');
    for (const { provider, trace } of traced) {
      const shown = trace.domains.slice(0, DIGEST_DOMAINS).join(', ');
      const more = trace.domains.length > DIGEST_DOMAINS ? ` и ещё ${trace.domains.length - DIGEST_DOMAINS}` : '';
      const what = shown
        ? `${shown}${more}`
        : trace.sources ? `источников ${trace.sources}, адреса не разобрать` : 'шлюз источников не вернул';
      // Счётчик — отметка намерения, а не число выполненных поисков (R-probe):
      // «поисков: 1» рядом с «шлюз источников не вернул» читалось как поиск.
      const count = trace.count !== null ? `; отметка намерения поиска: ${trace.count}` : '';
      lines.push(`${escapeHtml(provider)}: ${escapeHtml(what)}${escapeHtml(count)}`);
    }
  }
  lines.push(
    '',
    'В вопросах о сайте нет слова «Камчатка»: «знает» — модель назвала край сама. '
      + 'В тематическом вопросе (qwen-search-topic) край назван: «знает» там — назвала нас или нашла vedarai.ru среди источников.',
  );
  return lines.join('\n');
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const notify = request.nextUrl.searchParams.get('notify') === '1';
  const askedAt = new Date(started).toISOString();
  const legs = await Promise.all(LEGS.map(askLeg));
  const summary = summarize(legs);
  // Проба не состоялась только когда спросить не удалось НИКОГО: «не знает»
  // — законный результат замера, а не поломка.
  const asked = legs.length - summary.could_not_ask.length;
  if (asked > 0) {
    recordCronRun(SCOPE, started, 'success', { items: asked });
  } else {
    recordCronRun(SCOPE, started, 'failed', { items: 0, error: 'ни одну модель спросить не удалось' });
  }

  // Итог уходит и при неудаче: «замера нет» владелец тоже должен узнать.
  let notifyOutcome: { sent: boolean; reason: string } | null = null;
  if (notify) {
    const out = await tgSend(SCOPE, digestText(legs, summary));
    notifyOutcome = out.ok ? { sent: true, reason: 'доставлен' } : { sent: false, reason: out.reason };
  }

  return NextResponse.json({
    ok: asked > 0,
    error: asked > 0 ? null : 'ни одну модель спросить не удалось — замера нет',
    place: runPlace(),
    asked_at: askedAt,
    question: KNOWLEDGE_QUESTION,
    question_with_search: KNOWLEDGE_QUESTION_SEARCH,
    question_topic: KNOWLEDGE_QUESTION_TOPIC,
    question_ru: KNOWLEDGE_QUESTION_RU,
    legs,
    summary,
    notify: notifyOutcome,
    verdict: `знают: ${summary.knows.join(', ') || '—'}; не знают: ${summary.does_not_know.join(', ') || '—'}; `
      + (summary.did_not_search.length ? `не искали или выдачи нет: ${summary.did_not_search.join(', ')}; ` : '')
      + `спросить не удалось: ${summary.could_not_ask.join(', ') || '—'}`
      + (summary.old_brand.length ? `; под прежним именем платформы: ${summary.old_brand.join(', ')}` : ''),
  });
}
