/**
 * Опознание краулера по User-Agent — детерминированно, без сети и эвристик.
 *
 * Зачем: счётчик платформы пишется из браузера (PageViewTracker -> /api/analytics/hit),
 * и до сих пор в нём не было НИКАКОЙ отсечки ботов. Рендереры поисковиков и
 * headless-хром исполняют JS и попадали в «просмотры» наравне с людьми — в
 * источниках переходов это уже видно невооружённым глазом (aisearchindex.space).
 *
 * Бот не выбрасывается, а помечается: доля не-людей — величина, которую надо
 * видеть. Молча выбросить значило бы снова считать вслепую, только в другую
 * сторону.
 *
 * Список сознательно короткий и состоит из подстрок, которые бот сам про себя
 * пишет. Ловить «подозрительное поведение» тут не пытаемся: счётчик посещаемости
 * не место для гадания, а ошибочно помеченный человек хуже пропущенного бота.
 *
 * С 12.10 те же подстроки сгруппированы по СЕМЕЙСТВАМ (`BOT_FAMILIES`,
 * `botFamily`): перепись входов для агентов (lib/analytics/agent-entry-hits)
 * должна отличать Baidu от ByteDance, а не видеть одно слово «spider». Реестр
 * один на обоих читателей — `isBotUserAgent` берёт подстроки из него же.
 */

export interface BotFamily {
  /** Короткая метка семейства — она же пишется в перепись (agent_entry_hits.family). */
  family: string;
  /** Кому принадлежит, для человека. */
  vendor: string;
  /** Подстроки User-Agent (нижний регистр), которыми бот сам называет себя. */
  markers: readonly string[];
  /**
   * ИИ-краулер. На витрине посещаемости это отдельная строка «ИИ-краулеры»,
   * не общая куча ботов (владелец 24.10). Поисковый бот того же вендора
   * флага не получает: Googlebot — бот, Google-Extended — ИИ.
   */
  ai?: boolean;
}

/**
 * Семейства по вендору. Китайские — решение владельца 12.10. Подстроки —
 * самоназвания из документации краулеров. Для Sogou берётся полное имя
 * обходчика, а не «sogou»: это слово носят и браузеры Sogou у живых людей.
 */
export const BOT_FAMILIES: readonly BotFamily[] = [
  // Длинный токен раньше короткого: «applebot» иначе съедает Applebot-Extended.
  { family: 'google-extended', vendor: 'Google (обучение моделей)', markers: ['google-extended'], ai: true },
  { family: 'google',      vendor: 'Google',                  markers: ['googlebot', 'googleother', 'adsbot-google', 'mediapartners-google', 'storebot-google', 'google-inspectiontool', 'feedfetcher-google'] },
  { family: 'yandex',      vendor: 'Яндекс',                  markers: ['yandexbot', 'yandeximages', 'yandexmobilebot', 'yandexaccessibilitybot', 'yandexrenderresourcesbot', 'yandexscreenshotbot', 'yandexvideo', 'yandexwebmaster', 'yandexmetrika', 'yandexdirect', 'yandexnews', 'yandexmarket'] },
  { family: 'bing',        vendor: 'Microsoft',               markers: ['bingbot', 'bingpreview', 'msnbot', 'adidxbot'] },
  { family: 'yahoo',       vendor: 'Yahoo',                   markers: ['slurp'] },
  { family: 'openai',      vendor: 'OpenAI',                  markers: ['gptbot', 'oai-searchbot', 'chatgpt-user'], ai: true },
  { family: 'anthropic',   vendor: 'Anthropic',               markers: ['claudebot', 'anthropic-ai', 'claude-web', 'claude-user', 'claude-searchbot'], ai: true },
  { family: 'perplexity',  vendor: 'Perplexity',              markers: ['perplexitybot', 'perplexity-user'], ai: true },
  { family: 'you',         vendor: 'You.com',                 markers: ['youbot'], ai: true },
  { family: 'cohere',      vendor: 'Cohere',                  markers: ['cohere-ai'], ai: true },
  { family: 'ai2',         vendor: 'AI2',                     markers: ['ai2bot'], ai: true },
  { family: 'mistral',     vendor: 'Mistral',                 markers: ['mistralai-user', 'mistralai'], ai: true },
  { family: 'xai',         vendor: 'xAI',                     markers: ['grokbot', 'xai-grok'], ai: true },
  { family: 'baidu',       vendor: 'Baidu, КНР',              markers: ['baiduspider'] },
  { family: 'bytedance',   vendor: 'ByteDance, КНР',          markers: ['bytespider'] },
  { family: 'huawei',      vendor: 'Huawei, КНР',             markers: ['petalbot'] },
  { family: 'alibaba',     vendor: 'Alibaba (Shenma), КНР',   markers: ['yisouspider'] },
  { family: 'tencent',     vendor: 'Tencent (Sogou), КНР',    markers: ['sogou web spider'] },
  { family: '360',         vendor: '360 Search, КНР',         markers: ['360spider'] },
  { family: 'deepseek',    vendor: 'DeepSeek, КНР',           markers: ['deepseekbot'], ai: true },
  // Аудит 15.10, CN-detect: семейства не было, и визиты Kimi в переписи входов
  // уходили в «other-bot». Три обходчика — по первоисточнику
  // kimi.com/policies/kimi-crawlers (15.10): KimiBot (обучение), Kimi-SearchBot
  // (поисковый индекс Kimi), Kimi-User (запрос человека). Токены «Kimi»,
  // «Qwenbot», «Doubao» из чужих блок-листов и «chatglm-spider» не берутся:
  // у них нет первоисточника, и перепись называла бы то, чего не знает.
  { family: 'kimi',        vendor: 'Moonshot (Kimi), КНР',    markers: ['kimibot', 'kimi-searchbot', 'kimi-user'], ai: true },
  { family: 'apple-extended', vendor: 'Apple (обучение моделей)', markers: ['applebot-extended'], ai: true },
  { family: 'apple',       vendor: 'Apple',                   markers: ['applebot'] },
  { family: 'meta',        vendor: 'Meta',                    markers: ['meta-externalagent', 'facebookexternalhit'] },
  { family: 'amazon',      vendor: 'Amazon',                  markers: ['amazonbot'] },
  { family: 'duckassist',  vendor: 'DuckDuckGo (ответы)',     markers: ['duckassistbot'], ai: true },
  { family: 'duckduckgo',  vendor: 'DuckDuckGo',              markers: ['duckduckbot'] },
  { family: 'commoncrawl', vendor: 'Common Crawl',            markers: ['ccbot'] },
  { family: 'seo-tools',   vendor: 'SEO-сканеры',             markers: ['ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot'] },
  { family: 'messengers',  vendor: 'Превью мессенджеров и соцсетей', markers: ['telegrambot', 'whatsapp', 'skypeuripreview', 'discordbot', 'linkedinbot', 'twitterbot', 'vkshare'] },
];

/** Универсальные самоназвания — бот без вендора в реестре. */
const GENERIC_MARKERS = ['bot', 'crawler', 'spider', 'crawling'] as const;

/** Инструменты, мониторинг, headless — не краулер и не человек. */
const TOOL_MARKERS = [
  'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'webdriver', 'cypress',
  'curl/', 'wget/', 'python-requests', 'httpx', 'go-http-client',
  'axios/', 'node-fetch', 'lighthouse', 'pingdom', 'uptimerobot',
] as const;

/** Подстроки User-Agent (нижний регистр), по которым клиент честно объявляет себя не-человеком. */
const BOT_MARKERS: readonly string[] = [
  ...GENERIC_MARKERS,
  ...BOT_FAMILIES.flatMap((f) => f.markers),
  ...TOOL_MARKERS,
];

/** Семейства ИИ-краулеров — те же метки, что пишутся в page_views.ua_family. */
export const AI_FAMILY_NAMES: readonly string[] = BOT_FAMILIES.filter((f) => f.ai === true).map((f) => f.family);

export function isAiFamily(family: string | null | undefined): boolean {
  return !!family && AI_FAMILY_NAMES.includes(family);
}

/**
 * Литерал массива для SQL. Имена — из реестра, не из запроса: иначе витрина
 * и приём события разошлись бы в первый же день. Чужой символ — ошибка
 * сборки списка, а не дыра в запросе.
 */
export function aiFamilyArraySql(): string {
  const names = AI_FAMILY_NAMES.map((n) => {
    if (!/^[a-z0-9-]+$/.test(n)) throw new Error(`семейство «${n}» не литерал`);
    return `'${n}'`;
  });
  return `ARRAY[${names.join(',')}]::text[]`;
}

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // безымянный клиент — не браузер человека
  const ua = userAgent.toLowerCase();
  return BOT_MARKERS.some(m => ua.includes(m));
}

/**
 * Семейство клиента по User-Agent: метка из `BOT_FAMILIES`, иначе
 * `other-bot` (назвался ботом, вендора в реестре нет), `tool`, `browser`,
 * `none` (пустой UA) или `unknown`. Сырой UA наружу не уходит — только метка.
 */
export function botFamily(userAgent: string | null | undefined): string {
  if (!userAgent || !userAgent.trim()) return 'none';
  const ua = userAgent.toLowerCase();
  for (const f of BOT_FAMILIES) {
    if (f.markers.some((m) => ua.includes(m))) return f.family;
  }
  if (GENERIC_MARKERS.some((m) => ua.includes(m))) return 'other-bot';
  if (TOOL_MARKERS.some((m) => ua.includes(m))) return 'tool';
  if (ua.includes('mozilla')) return 'browser';
  return 'unknown';
}

/**
 * Свой ли это домен. Реферер с собственного домена — не «источник перехода»,
 * а внутренняя навигация; попав в список внешних, он врёт про приток.
 * tourhab.ru — прежнее имя платформы, оно продолжает приводить людей
 * редиректами, и его переходы тоже наши.
 */
const OWN_HOSTS = ['vedarai.ru', 'tourhab.ru', 'tourhabk.ru', 'localhost'];

export function isOwnReferrer(referrer: string | null | undefined): boolean {
  if (!referrer) return false;
  const r = referrer.toLowerCase();
  return OWN_HOSTS.some(h => r.includes(h));
}
