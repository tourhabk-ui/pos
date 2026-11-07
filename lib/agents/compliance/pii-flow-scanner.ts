/**
 * Compliance Sentinel — детерминированный сканер утечки ПД в зарубежные LLM.
 *
 * 152-ФЗ минимизирует трансграничную передачу персональных данных. Платформа
 * хостится в РФ, но модели `callAIFast`/`callAIWaterfall`/`callAIWithModel`/
 * `callAIDecision` ходят в зарубежные провайдеры (DeepSeek/Gemini/OpenRouter).
 * Значит телефон/почта/имя туриста НЕ должны попадать в текст промпта без
 * псевдонимизации: телефон и почту режет `redactPII`, имя — только плейсхолдер
 * `{name}` (redactPII имён не трогает, lib/security/pii-redact.ts).
 *
 * Это НЕ ИИ-«юрист». Это узкий детерминированный страж в пределах одного
 * файла: он читает исходник, находит ТЕКСТ ПРОМПТА (template literal у
 * переменной `*prompt*`, значение `content:`, аргумент двери к зарубежной
 * модели — и то, что течёт в них через переменные, поля, массивы, склейки,
 * параметры и функции внутри файла, `promptFlow`) и ловит в нём однозначные
 * ПД-поля (`.phone`, `.email`, персональные `*_name`/`lead.name`), переменные с
 * именем контакта и всё, что несёт их род (`taintsIn`), без чистки: в `${…}`
 * шаблона и в самом значении стока (`content: lead.email`, `'Тел: ' + phone`).
 * Поток между файлами (сборщик в одном, вызов в другом) он не видит — это
 * добивает ревью.
 *
 * Философия репо (CLAUDE.md §8): лучше узкий детерминированный guard с
 * allowlist, чем абзацы в промпте агента. Ложные срабатывания дороги (блокируют
 * CI), поэтому правило точечное: телефон/почта не двусмысленны (у места их нет),
 * имена — только явные персональные поля. Что не поймали — добьёт ревью и дайджест.
 *
 * Чистые функции — под тестом, без сети и без ФС в ядре (`scanSource`).
 */

import { LLM_ENDPOINTS, extractLLMHosts } from './provider-registry';

/**
 * Функции `lib/ai/providers.ts`, уходящие в ЗАРУБЕЖНЫЙ LLM: аргумент такого
 * вызова — промпт. Реестр полный, и это держит тест: каждый экспорт `call*`
 * провайдеров обязан стоять здесь или в DOMESTIC_LLM_CALLERS, иначе набор
 * красный. Пятое ревью PR #3104: здесь было 10 дверей из 42, и ни
 * `callAIQuality`, ни `callAIFastOrNull` стоком не были — тот же перечень
 * знакомых написаний вместо правила, что ниже у полей ПД.
 */
export const FOREIGN_LLM_CALLERS = [
  // Водопады и обёртки: хотя бы одна нога — за рубежом.
  'callAICheap', 'callAIDecision', 'callAIDecisionDetailed', 'callAIFast', 'callAIFastOrNull',
  'callAIQuality', 'callAIQualityOrNull', 'callAIWaterfall', 'callAIWaterfallDebug',
  'callAIWaterfallDetailed', 'callAIWaterfallOrNull', 'callAIWithModel', 'callAIWithModelDirect',
  'callToolsWaterfall',
  // Провайдеры напрямую.
  'callAnthropic', 'callCerebras', 'callDeepSeek', 'callDeepSeekWithTools', 'callFugu', 'callGLM',
  // Дверь в Google — `callGeminiDirect` (водопад), `callGeminiTranscribe` (голос в
  // Telegram/MAX), `callGeminiPDF`. Раньше здесь стоял `callGemini` — вариант через
  // OpenRouter, которого не звал никто: страж сторожил не ту дверь.
  'callGeminiDirect', 'callGeminiPDF', 'callGeminiTranscribe',
  'callGroq', 'callKimi', 'callMiniMax', 'callMinimax', 'callMistral', 'callMuseSpark', 'callNvidia',
  'callOpenRouterModel', 'callOpenRouterWithTools', 'callOpenrouter',
  'callQwen', 'callQwenSearch', 'callQwenWithTools',
  // Шлюз Timeweb: хост в РФ, но запрос уходит дальше, к производителю модели (CLAUDE.md §8).
  'callTimewebAgent', 'callTimewebGatewayWithTools',
  'callVision', 'callVisionDetailed', 'callXai', 'callXaiWithTools',
] as const;

/** Домашние стоки (YandexGPT, РФ): трансграничной передачи нет. */
export const DOMESTIC_LLM_CALLERS = ['callYandexAgentWithMcp', 'callYandexGPT'] as const;

/**
 * Двери вне `lib/ai/providers.ts`: файлы `lib/`, которые сами ходят на
 * зарубежный хост модели из реестра D2, и решение по каждому их экспорту.
 * Дверь — функция, чьи аргументы уходят модели; прочие экспорты названы с
 * причиной. Тест сверяет реестр с файлами: файл с хостом модели без записи и
 * экспорт без решения краснят набор. Седьмое ревью PR #3104: `runSDKAgent`
 * (прямой `fetch` к OpenRouter) дверью не был, и промпт через него страж не видел.
 */
export const EGRESS_DOORS: Readonly<Record<string, { doors: readonly string[]; others: readonly string[]; why: string }>> = {
  'lib/agents/sdk/sdk-runner.ts': {
    doors: ['runSDKAgent'], others: [],
    why: 'агент SDK: системная подсказка и сообщение уходят в OpenRouter',
  },
  'lib/ai/visibility-ask.ts': {
    doors: ['askAssistant', 'runPanelDay'],
    others: ['pickGeminiFlash', 'readPricedCatalog', 'choosePanelModels', 'estimateCallUsd', 'planDay', 'extractSources'],
    why: 'прочие выбирают модели, читают каталог цен, планируют день и разбирают ответ — текста вызывающего не шлют',
  },
  'lib/ai/west-probe.ts': {
    doors: ['askWestLeg', 'runWestProbe'],
    others: ['westVersion', 'pickWestModel', 'chooseWestModels', 'markerOverrides', 'readOpenRouterCatalog', 'westProbeExitCode', 'formatLegLine', 'renderWestSummary'],
    why: 'прочие выбирают модели, читают каталог и печатают итог пробы — текста вызывающего не шлют',
  },
  'lib/ai/xai-x-search.ts': {
    doors: ['searchX'],
    others: ['pickXSearchModel', 'xSearchDateWindow', 'buildXSearchPrompt', 'parseXSearchAnswer', 'xSearchResultFromRunner'],
    why: 'прочие собирают подсказку и разбирают ответ на месте; уходит она через searchX',
  },
  'lib/notifications/cover-image.ts': {
    doors: ['composeCoverPrompt', 'generateQwenImageUrl', 'resolveCoverImage'],
    others: ['getDashScopeImageConfig', 'dashScopeImageEnabled', 'usesMultimodalImageApi'],
    why: 'прочие читают настройки DashScope и выбирают вид API — текста вызывающего не шлют',
  },
  'lib/services/ingest/mistral-ocr.ts': {
    doors: ['ocrPdfBase64'], others: ['joinOcrPages'],
    why: 'joinOcrPages склеивает уже полученные страницы, ocrPdfBase64 шлёт документ в Mistral',
  },
  'lib/ai/balances.ts': {
    doors: [], others: ['parseDeepSeekBalance', 'collectProviderBalances'],
    why: 'остаток счёта провайдера: запрос без текста вызывающего',
  },
  'lib/config.ts': {
    doors: [], others: ['isTechnicalHost', 'getPublicBaseUrl', 'validateConfig'],
    why: 'хост — адрес по умолчанию в конфиге, запроса нет',
  },
};

/** Все двери к зарубежной модели: провайдеры и файлы с прямым выходом. */
const FOREIGN_DOORS: readonly string[] = [...FOREIGN_LLM_CALLERS, ...Object.values(EGRESS_DOORS).flatMap((e) => e.doors)];
const FOREIGN_DOOR_WORD = new RegExp(`\\b(?:${FOREIGN_DOORS.join('|')})\\b`);
const FOREIGN_LLM_HOSTS: ReadonlySet<string> = new Set(LLM_ENDPOINTS.filter((e) => !e.domestic).map((e) => e.host));

/**
 * Говорит ли файл с зарубежной моделью: зовёт дверь или сам ходит на
 * зарубежный хост модели (адрес в коде, не в комментарии). Маршрут с прямым
 * `fetch('https://openrouter.ai/…')` собирает тело запроса тут же, и его
 * `content:` — сток (седьмое ревью PR #3104).
 */
function fileTalksAbroad(src: string): boolean {
  return FOREIGN_DOOR_WORD.test(src) || extractLLMHosts(src).some((h) => FOREIGN_LLM_HOSTS.has(h)) || LLM_API_PATH.test(src);
}

/**
 * Путь API модели в адресе запроса: `${OR_BASE}/chat/completions`,
 * `${ANTHROPIC_BASE}/v1/messages`, `:generateContent`. База из импорта или
 * окружения хостом в тексте не видна (тринадцатое ревью PR #3104:
 * `lib/ai/image-tagger.ts` спасало только имя переменной `prompt`), а путь —
 * виден. Домашний YandexGPT ходит на `/foundationModels/v1/completion`, и
 * этот путь сюда не входит.
 */
const LLM_API_PATH = /\/chat\/completions\b|\/v1\/messages\b|\/v1\/responses\b|:(?:stream)?[gG]enerateContent\b/;

/**
 * Однозначные ПД-поля. У места, тура и маршрута их нет — ложняков нет.
 *
 * ПРЕФИКС ОБЯЗАТЕЛЬНО УЧИТЫВАЕТСЯ (04.09). Прежний шаблон требовал, чтобы имя
 * поля НАЧИНАЛОСЬ с ключевого слова, и потому видел `.email` и `.phone`, но не
 * видел `.user_email`, `.customer_email`, `.partner_email`, `.operator_email`,
 * `.user_phone`, `.contact_phone` — то есть ровно те имена, которыми поля
 * названы в НАШЕЙ базе: в реестре строк пятнадцать интерфейсов несут почту или
 * телефон, и почти все с приставкой. Замер пробой: из двенадцати выражений
 * сканер видел два.
 *
 * Тот же класс слепоты, что нашёлся 04.09 у сканера хостов D2: перечень
 * знакомых написаний вместо правила. Сторож, который не видит того, ради чего
 * заведён, хуже отсутствующего — на него полагаются.
 *
 * Приставка отделяется подчёркиванием намеренно: без этого `.hotel` попадал бы
 * под `tel`. Хвостовое `s?` ловит множественное число (`.emails`), но не
 * `email_template`: после `email` там подчёркивание, а это словесный символ, и
 * границы слова нет.
 *
 * Состав расширен по правилу 152-ФЗ, которое сформулировал разбор в дайджесте
 * 05.09: персональные данные — любая информация, относящаяся к определяемому
 * лицу, и безопасный подход считать ПД идентификаторы тоже. Отсюда паспорт,
 * ИНН, СНИЛС, адрес, дата рождения и идентификатор Telegram.
 */
/**
 * Экспортируется 08.09: тот же список слов читает перепись возможностей
 * крон-роутов (`lib/agents/cron-capabilities`). Скопировать его туда значило
 * бы завести второй ответ на вопрос «что здесь персональные данные» — и
 * второй разошёлся бы с первым молча (§12).
 */
export const CONTACT_WORD = 'telegram_id|telegram_username|chat_id|phone_number|phonenumber|passport_number'
  + '|passport|birth_date|birthday|whatsapp|telegram|address|snils|inn|telephone|email_address|phone|email|e_mail|mobile|tel|contacts?';

/**
 * Что `redactPII` чистит, а что нет (одиннадцатое ревью PR #3104): он режет
 * почту и цепочки цифр телефона (lib/security/pii-redact.ts), а адрес, дату
 * рождения, паспорт, ИНН, СНИЛС, ник и id мессенджера оставляет как есть.
 * Первые — род `contact`, его гасит чистка; вторые — род `ident`, его чистка
 * не гасит, как и имя. Наружу оба — находка `contact`. Вместе слова — ровно
 * `CONTACT_WORD` (держит тест).
 */
export const REDACTABLE_WORD = 'phone_number|phonenumber|telephone|email_address|phone|email|e_mail|mobile|tel';
export const IDENT_WORD = 'telegram_id|telegram_username|chat_id|passport_number|passport|birth_date|birthday|whatsapp|telegram|address|snils|inn|contacts?';

/**
 * Явные персональные имена (не «название вулкана»): по полю или по владельцу.
 * `display_name` — как голое `name`: так названы и контакты CRM, и парки
 * (`lib/parks`), и модели в каталоге; судит владелец (`contact.display_name`).
 */
export const PERSONAL_NAME_FIELD =
  /\b(customer|client|full|first|last|user|guest|traveler|traveller|tourist|contact|passenger|buyer|payer)_name\b/i;
export const PERSONAL_OWNER_NAME =
  /\b(lead|leads|l|booking|bookings|b|user|users|u|member|members|m|guest|guests|g|client|clients|customer|customers|traveler|traveller|tourist|tourists|passenger|buyer|payer|contact|contacts|profile|profiles)\s*\.\s*(?:display_)?name\b/i;

/**
 * Идентификатор в снейк-регистре (тринадцатое ревью PR #3104): страж судит не
 * написание, а имя. `phoneNumber`, `touristPhone`, `fullName`, `telegramId`,
 * `emailAddress` судятся как `phone_number`, `tourist_phone`, `full_name`,
 * `telegram_id`, `email_address`. Граница слова — только `_` или заглавная:
 * `hotel` остаётся гостиницей, а не `tel`.
 */
export function snakeId(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
}
/** Телефон или почта — их режет redactPII. Телефон МЧС у маршрута — служба, не человек. */
const isRedactableId = (id: string): boolean => {
  const s = snakeId(id);
  return s !== 'mchs_phone' && REDACTABLE_NAMED.test(s);
};
/** Адрес, документ, мессенджер — их redactPII не режет; `email_address` — почта, а не адрес. */
const isIdentId = (id: string): boolean => {
  const s = snakeId(id);
  return IDENT_NAMED.test(s) && !REDACTABLE_NAMED.test(s);
};
/** Имя человека: `tourist_name`, `fullName`, `display_name`. */
const isPersonNameId = (id: string): boolean => PERSONAL_NAME_COLUMN.test(snakeId(id));

/** Обращение к полю: `.phone`, `?.phoneNumber`, `. user_email` — позиция точки, текст, имя. */
const FIELD_REF = /\.\s*([A-Za-z_$][\w$]*)/g;
function fieldRefs(text: string, pred: (id: string) => boolean): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = [];
  for (const m of text.matchAll(FIELD_REF)) if (pred(m[1])) out.push({ index: m.index ?? 0, text: m[0] });
  return out;
}
/** Идентификаторы текста, подходящие под правило: `tourist_name`, `fullName` — позиция и имя. */
const IDENT_REF = /(?<![\w$])[A-Za-z_$][\w$]*/g;
function identRefs(text: string, pred: (id: string) => boolean): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = [];
  for (const m of text.matchAll(IDENT_REF)) if (pred(m[0])) out.push({ index: m.index ?? 0, text: m[0] });
  return out;
}

/**
 * ПД, положенные в локальную переменную, а оттуда в промпт.
 *
 * Дыра, найденная 23.08: дайджест платформы годами отдавал зарубежной модели
 * «имя | телефон» каждого нового лида, и страж был зелёным. Строка выглядела
 * так:
 *
 *     const name = l.name ?? 'Турист';
 *     const phone = l.phone;
 *     return `  - ${name} | ${phone} | ${interest} | ${time}`;
 *
 * Прямого `l.phone` в промпте нет — значит и находки нет. Правило, которое
 * ловит одно написание из двух, даёт ложное «чисто»: хуже, чем отсутствие
 * правила, потому что на него полагаются.
 *
 * Поэтому сначала собираем род ПД переменных файла, а потом считаем
 * интерполяцию такой переменной равной интерполяции самого поля.
 *
 * Цепочка бывает длиннее одного шага — в дайджесте она была двухзвенной:
 * `l.phone` → `phone` → строка `leadsStr` → промпт. Поэтому род собирается ДО
 * НЕПОДВИЖНОЙ ТОЧКИ по рёбрам потока (`taintsIn`).
 */
/** Деструктуризация: только однозначные контакты. `name` тут слишком част. */
const DESTRUCT = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
const DESTRUCT_CONTACT = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/;

/**
 * Чистка контактов: `redactPII`/`redact` режут телефоны и почту — и только их
 * (lib/security/pii-redact.ts: «имя туриста стоит убирать отдельно»). Для рода
 * `name` чисткой они не считаются: прежний `SAFE_WRAP` гасил и находку имени,
 * а сообщение гейта советовало «оберни в redactPII()» — совет выполнялся, гейт
 * зеленел, имя уходило за рубеж (пятое ревью PR #3104). Имя убирает только
 * плейсхолдер `{name}` — текст подсказки, а не подстановка `${name}`.
 * Чистка действует по месту: поле вне её аргументов — находка, даже если
 * рядом в том же выражении что-то очищено (`lead.phone + redactPII(x)`).
 */
type Kind = 'contact' | 'name' | 'ident';
/**
 * Только `redactPII`: голого `redact` с чисткой ПД в репозитории нет, а имя
 * занято другими (`redactWebhookUrl`, `redactDeep`) — белый список шире, чем
 * за него кто-то ручается (одиннадцатое ревью).
 */
const CONTACT_SANITIZERS: ReadonlySet<string> = new Set(['redactPII']);
const NO_SANITIZERS: ReadonlySet<string> = new Set();

/** Отрезки аргументов вызовов-чисток (`redactPII(…)`) внутри [from, to) кода. */
function sanitizedRanges(code: string, from: number, to: number, cutters: ReadonlySet<string>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (cutters.size === 0) return out;
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  re.lastIndex = from;
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    if (!cutters.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    out.push([open, open + 1 + argsAfter(code, open).length]);
  }
  return out;
}

const insideAny = (at: number, ranges: ReadonlyArray<[number, number]>): boolean => ranges.some(([a, b]) => at > a && at < b);

/** Текст с позиции `base` с вычищенными отрезками (длина и переводы строк те же). */
function blankRanges(text: string, base: number, ranges: ReadonlyArray<[number, number]>): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const [a, b] of ranges) {
    for (let k = Math.max(a, base); k < Math.min(b, base + text.length); k++) if (chars[k - base] !== '\n') chars[k - base] = ' ';
  }
  return chars.join('');
}

export interface PIIFinding {
  file: string;
  line: number;
  /** Текст интерполяции, напр. `lead.phone`. */
  expr: string;
  /** Что именно поймали: 'contact' (тел/почта) или 'name' (персональное имя). */
  kind: 'contact' | 'name';
  /** Контекст промпта: имя переменной / 'content' / имя зарубежного вызова. */
  context: string;
}

interface TemplateLiteral {
  /** Метка-контекст перед открывающим бэктиком: имя переменной / ключ / функция. */
  label: string;
  /** У `X.push(\`…\`)` — X: литерал кладётся в массив X. */
  receiver?: string;
  /** Смещение открывающего бэктика в исходнике. */
  start: number;
  /** Тело литерала (между бэктиками, с `${…}`). */
  body: string;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Методы, кладущие значение в коллекцию: `X.push(…)` — X получает текст. */
const PUSHERS = new Set(['push', 'unshift', 'add', 'concat']);

/** Читает идентификатор, заканчивающийся на позиции `end` (эксклюзивно), справа налево. */
function identBefore(src: string, end: number): string {
  let i = end;
  while (i > 0 && IDENT_CHAR.test(src[i - 1])) i--;
  return src.slice(i, end);
}

/**
 * Извлекает template literals с их контекст-метками. Метка — идентификатор перед
 * `= \``, `+= \``, `: \`` или `(\``; у `X.push(\`` ещё и получатель X.
 *
 * Границы читаются по маске (`maskCode`): в ней бэктик стоит только на
 * настоящей границе шаблона, `${` — только в подстановке, а строки,
 * комментарии и регулярные выражения затёрты. Тело берётся из исходника по тем
 * же позициям. До 07.11 у литералов был свой разбор, не знавший регулярных
 * выражений: три бэктика в `/```json/` открывали шаблон, который глотал код до
 * следующего бэктика файла, и промпт за ним не находился вовсе.
 */
function extractTemplateLiterals(src: string, code: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];
  const push = (open: number, end: number, label: string, receiver?: string) =>
    out.push({ label, start: open, body: src.slice(open + 1, end), ...(receiver ? { receiver } : {}) });

  // Один литерал с открывающим бэктиком на `open`; возвращает индекс за закрывающим.
  function parseTemplate(open: number, label: string, receiver?: string): number {
    let i = open + 1;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '`') { push(open, i, label, receiver); return i + 1; }
      if (ch === '$' && code[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < code.length && depth > 0) {
          const c = code[i];
          if (c === '{') { depth++; i++; }
          else if (c === '}') { depth--; i++; }
          else if (c === '`') i = parseTemplate(i, '');
          else i++;
        }
        continue;
      }
      i++;
    }
    push(open, i, label, receiver);
    return i;
  }

  let i = 0;
  while (i < code.length) {
    if (code[i] === '`') {
      let j = i - 1;
      while (j > 0 && /\s/.test(code[j])) j--;
      const prev = code[j];
      let label = '';
      let receiver: string | undefined;
      if (prev === '=' || prev === ':' || prev === '(') {
        let k = j;
        // `x += \`…\`` — дописывание к переменной: метка — сама переменная.
        if (prev === '=' && code[k - 1] === '+') k--;
        while (k > 0 && /\s/.test(code[k - 1])) k--;
        label = identBefore(code, k);
        const head = k - label.length;
        if (prev === '(' && PUSHERS.has(label) && code[head - 1] === '.') receiver = identBefore(code, head - 1) || undefined;
      }
      i = parseTemplate(i, label, receiver);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Пропускает строковый литерал, начиная с кавычки на позиции `open`. Строка в
 * кавычках на новую строку не переходит — кроме значения атрибута JSX сразу
 * после `=` (длинный `className="…"`): одинокая кавычка (апостроф в тексте
 * JSX) глотает только хвост своей строки, а не код до следующей кавычки файла.
 */
function skipString(src: string, open: number): number {
  const quote = src[open];
  const attribute = src[open - 1] === '=';
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    if (src[i] === '\n' && !attribute) return i;
    i++;
  }
  return i;
}

/**
 * Все `${…}`-подстановки текста со смещением внутри него. `masked` — тот же
 * отрезок по маске (`maskCode`): скобки считаются по нему, поэтому `}` в строке
 * или регулярном выражении внутри `${…}` подстановку не закрывает, а `\${` в
 * тексте шаблона подстановкой не считается. Выражение берётся из `text`.
 */
function interpolations(text: string, masked: string): Array<{ expr: string; at: number }> {
  const res: Array<{ expr: string; at: number }> = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] === '$' && masked[i + 1] === '{') {
      const at = i;
      i += 2;
      const from = i;
      let depth = 1;
      while (i < masked.length) {
        const c = masked[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      res.push({ expr: text.slice(from, i), at });
    }
    i++;
  }
  return res;
}

/** Подстановки литерала: маска того же тела — из кода файла по смещению литерала. */
function literalInterpolations(lit: TemplateLiteral, code: string): Array<{ expr: string; at: number }> {
  return interpolations(lit.body, code.slice(lit.start + 1, lit.start + 1 + lit.body.length));
}

/**
 * Род ПД переменных файла: имя локальной переменной → род ПД — для теста и
 * разбора находки. Род, пришедший СКВОЗЬ redactPII, контактом не считается.
 * Ключ здесь — голое имя; сканер сверяет по областям видимости (`taintsIn`).
 */
export function pdAliases(src: string): Map<string, 'contact' | 'name'> {
  const code = maskCode(src);
  const sc = buildScopes(code);
  const out = new Map<string, 'contact' | 'name'>();
  const links: Link[] = [];
  const edges = buildEdges(code, sc, links);
  for (const [key, kinds] of taintsIn(code, sc, edges, [], links, src).vars) {
    out.set(nameOfKey(key), kinds.has('contact') || kinds.has('ident') ? 'contact' : 'name');
  }
  return out;
}

/** Ребро потока: переменная (ключ области) получает текст отрезка. */
interface Edge {
  key: string;
  /** Имя цели, как оно стоит в коде (`prompt`, `ctx`): метка находки и признак промпта. */
  name: string;
  span: FlowSpan;
  /**
   * Цель получает часть отрезка — поле объекта (`const { text } = opts`): поток
   * по такому ребру идёт, а род ПД объекта — нет (чтение поля, `carrierOf`).
   */
  part?: boolean;
}

/**
 * Связь рода между ключами, без отрезка кода. `fields` — поля цели получают
 * поля источника на один уровень (`const b = a`, `ask(o)`, элемент перебора:
 * `b.k` — род `a.k`); иначе цель получает род самого ключа-источника
 * (`const { body } = o` — род `o.body`).
 */
interface Link { from: string; to: string; fields: boolean }

/** Сток: отрезок, текст которого уходит модели, и метка находки. */
interface Seed {
  span: FlowSpan;
  context: string;
  /** Переменная `*prompt*`, получающая текст: ключ — в поток. */
  key?: string;
}

/** Имя переменной-промпта. */
const PROMPT_NAME = /prompt|instruction/i;

/** Позиция скобки, парной закрывающей на `close`, или -1. */
function openOf(code: string, close: number): number {
  const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const want = pair[code[close]];
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === code[close]) depth++;
    else if (code[i] === want && --depth === 0) return i;
  }
  return -1;
}

/**
 * Корень цепочки `a.b[0].c` или `rows.filter(f).map`, кончающейся на `end`:
 * имя и позиция. У `this.x.y` корень — x, как у корня выражения `this.x`.
 */
function chainRoot(code: string, end: number): { name: string; at: number } | null {
  let i = end;
  let cur: { name: string; at: number } | null = null;
  let prev: { name: string; at: number } | null = null;
  for (;;) {
    let j = i;
    while (j > 0 && /\s/.test(code[j - 1])) j--;
    if (code[j - 1] === ']' || code[j - 1] === ')') {
      const o = openOf(code, j - 1);
      if (o < 0) break;
      i = o;
      continue;
    }
    const id = identBefore(code, j);
    if (!id) break;
    prev = cur;
    cur = { name: id, at: j - id.length };
    let k = cur.at;
    while (k > 0 && /\s/.test(code[k - 1])) k--;
    if (code[k - 1] !== '.' || code[k - 2] === '.') break;
    i = code[k - 2] === '?' ? k - 2 : k - 1;
  }
  if (cur?.name === 'this') return prev;
  return cur && !NOT_ROOT.has(cur.name) ? cur : null;
}

/** `x[i] = …`, `rows[0].note = …` — присваивание элементу. */
const INDEX_ASSIGN = /\]\s*\+?=(?![=>])/g;
/** `const { a, b: c } = …`, `let [a, b] = …`. */
const DESTRUCT_DECL = /\b(?:const|let|var)\s*([{[])/g;
/** `for (const l of leads)`, `for await (const [k, v] of map)`. */
const FOR_OF = /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+/g;
/** Метод-перебор: первый параметр колбэка — элемент получателя; у reduce — второй. */
const OBJECT_ASSIGN = /\bObject\s*\.\s*assign\s*\(/g;
/** Методы, чей результат — элементы получателя с теми же полями: `rows.at(0)`, `rows.find(…)`. */
const ELEMENT_METHODS: ReadonlySet<string> = new Set(['at', 'find', 'findLast', 'filter', 'slice', 'sort', 'toSorted', 'reverse', 'toReversed']);
const ITER_CALL = /\.\s*(map|flatMap|forEach|filter|find|findLast|findIndex|some|every|sort|reduce|reduceRight)\s*\(/g;
/** Голова колбэка: `(a, b) =>`, `async (a) =>`, `a =>`, `function (a) {`. */
const CALLBACK_HEAD = /^\s*(?:async\s*)?(?:function\b\s*\*?\s*[A-Za-z_$]*\s*)?(?:\(([^()]*(?:\([^()]*\)[^()]*)*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]+?)?(=>|\{)/;

/**
 * Записи литерала объекта на верхнем уровне: `{ k: v, tel }` — ключ и отрезок
 * значения (для `tel` — само имя); `...x` — запись без ключа с `spread`.
 */
function objectEntries(code: string, open: number): Array<{ key: string; span: FlowSpan; spread?: true }> {
  const out: Array<{ key: string; span: FlowSpan; spread?: true }> = [];
  const close = closeOf(code, open);
  let from = open + 1;
  let depth = 0;
  const flush = (to: number) => {
    const seg = code.slice(from, to);
    const kv = /^\s*(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*:(?!:)/.exec(seg);
    if (kv) out.push({ key: kv[1] ?? kv[2] ?? kv[3] ?? '', span: { from: from + kv[0].length, to } });
    else {
      const short = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(seg);
      const spread = /^\s*\.\.\./.exec(seg);
      if (short) out.push({ key: short[1], span: { from: from + seg.indexOf(short[1]), to: from + seg.indexOf(short[1]) + short[1].length } });
      else if (spread) out.push({ key: '', span: { from: from + spread[0].length, to }, spread: true });
    }
  };
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i) - 1; continue; }
    if (c === '`') { i = templateParts(code, i).end - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { flush(i); from = i + 1; }
  }
  flush(close);
  return out.filter((e) => e.key !== '' || e.spread);
}

/**
 * Рёбра потока файла: куда течёт текст. Одни и те же для потока в промпт
 * (`promptFlow`) и для рода ПД (`taintsIn`) — седьмое ревью PR #3104: род ПД
 * ходил только через `${…}` объявлений, и параметр, поле и голое
 * `const b = a` цепочку рвали, хотя поток по ним шёл.
 */
function buildEdges(code: string, sc: Scopes, links: Link[] = []): Edge[] {
  const edges: Edge[] = [];
  const add = (name: string, at: number, span: FlowSpan, part = false) => {
    if (!NOT_ROOT.has(name)) edges.push({ key: sc.key(name, at), name, span, ...(part ? { part } : {}) });
  };
  /**
   * Отрезок — переменная, её поле или элемент: `rows`, `this.x`, `res.rows`,
   * `rows[0]`, `rows.at(-1)`, `rows.find(…)`, `rows[0] ?? null`. Ключ, поля
   * которого получает цель; иначе null. Элемент коллекции несёт поля её строк
   * (двенадцатое ревью PR #3104: `const first = rows[0]` терял `first.name`).
   */
  const pathKey = (span: FlowSpan): string | null => {
    let i = skipWs(code, span.from);
    const head = /^(?:await\s+)?(?:this\s*\??\.\s*)?([A-Za-z_$][\w$]*)/.exec(code.slice(i, Math.min(span.to, i + 120)));
    if (!head || NOT_ROOT.has(head[1]) || sc.functions.has(head[1])) return null;
    const rootAt = i + head[0].length - head[1].length;
    i += head[0].length;
    const path: string[] = [];
    for (let guard = 0; guard < 16; guard++) {
      i = skipWs(code, i);
      if (i >= span.to) break;
      if (code[i] === '!' && code[i + 1] !== '=') { i++; continue; }
      if (code[i] === '[') { i = closeOf(code, i) + 1; continue; }
      const step = /^\??\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 80));
      if (!step) break;
      const k = skipWs(code, i + step[0].length);
      if (code[k] === '(') {
        if (!ELEMENT_METHODS.has(step[1])) return null;
        i = closeOf(code, k) + 1;
        continue;
      }
      path.push(step[1]);
      i += step[0].length;
    }
    // Запас на пустой результат: `?? null`, `|| undefined`, `?? []`.
    if (!/^\s*(?:(?:\?\?|\|\|)\s*(?:null|undefined|\[\s*\]))?\s*;?\s*$/.test(code.slice(i, span.to))) return null;
    const key = sc.key(head[1], rootAt);
    return path.length ? `${key}.${path.join('.')}` : key;
  };
  /**
   * Цель получает поля значения: литерала объекта — по записям, массива
   * литералов объектов — по записям элементов (поля коллекции — поля её
   * элементов), имени, поля или элемента — связью полей.
   */
  const fieldsInto = (target: string, span: FlowSpan, depth = 0) => {
    const lb = skipWs(code, span.from);
    const objects = code[lb] === '{' && closeOf(code, lb) < span.to ? [lb]
      : code[lb] === '[' && closeOf(code, lb) < span.to ? argSpans(code, lb).map((el) => skipWs(code, el.from)).filter((at) => code[at] === '{')
      : [];
    if (objects.length) {
      for (const at of objects) {
        for (const entry of objectEntries(code, at)) {
          // `{ ...lead }` — поля источника; `{ info: { name: lead.name } }` — поле
          // второго уровня `rec.info.name` (тринадцатое ревью PR #3104).
          if (entry.spread) {
            const from = pathKey(entry.span);
            if (from) links.push({ from, to: target, fields: true });
            continue;
          }
          edges.push({ key: `${target}.${entry.key}`, name: entry.key, span: entry.span });
          // Глубже — только литерал: связь полей с именем (`{ next: state }`)
          // замкнула бы путь сам на себя (`state.next.next…`).
          const inner = skipWs(code, entry.span.from);
          if (depth < 4 && (code[inner] === '{' || code[inner] === '[')) fieldsInto(`${target}.${entry.key}`, entry.span, depth + 1);
        }
      }
      return;
    }
    const from = pathKey(span);
    if (from) links.push({ from, to: target, fields: true });
  };
  // Присваивание и объявление; поле — по корню цепочки (`this.x` — x, `box.v` — box).
  ASSIGN_HEAD.lastIndex = 0;
  for (let m = ASSIGN_HEAD.exec(code); m; m = ASSIGN_HEAD.exec(code)) {
    // Тип не выходит из своих скобок: в `function f(lead: Lead) { const who =`
    // «тип» `: Lead) { const who` съел бы объявление who (девятое ревью).
    if (!balancedType(code.slice(m.index + m[1].length, m.index + m[0].length))) {
      ASSIGN_HEAD.lastIndex = m.index + m[1].length;
      continue;
    }
    const from = m.index + m[0].length;
    const span = { from, to: stmtEnd(code, from) };
    const target = chainRoot(code, m.index + m[1].length) ?? { name: m[1], at: m.index };
    add(target.name, target.at, span);
    const rootKey = NOT_ROOT.has(target.name) ? '' : sc.key(target.name, target.at);
    // Поле на один уровень: `box.value = lead.phone` — род у `box.value`.
    if (rootKey && target.name !== m[1] && /^\s*\??\.\s*$/.test(code.slice(target.at + target.name.length, m.index))) {
      edges.push({ key: `${rootKey}.${m[1]}`, name: m[1], span });
    }
    // Литерал объекта (`const ctx = { tel: lead.phone }` — род у `ctx.tel`) или
    // имя (`const b = a` — поля b из полей a).
    if (rootKey && target.name === m[1]) fieldsInto(rootKey, span);
  }
  INDEX_ASSIGN.lastIndex = 0;
  for (let m = INDEX_ASSIGN.exec(code); m; m = INDEX_ASSIGN.exec(code)) {
    // `parts: string[] = []` — пустые скобки: тип, а не элемент.
    const open = openOf(code, m.index);
    if (open < 0 || code.slice(open + 1, m.index).trim() === '') continue;
    const target = chainRoot(code, m.index + 1);
    const from = m.index + m[0].length;
    if (target) add(target.name, target.at, { from, to: stmtEnd(code, from) });
  }
  // Деструктуризация: каждое связанное имя получает правую часть.
  DESTRUCT_DECL.lastIndex = 0;
  for (let m = DESTRUCT_DECL.exec(code); m; m = DESTRUCT_DECL.exec(code)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    let k = skipWs(code, close + 1);
    if (code[k] === ':') { const eq = code.indexOf('=', k); if (eq < 0) continue; k = eq; }
    if (code[k] !== '=' || code[k + 1] === '=' || code[k + 1] === '>') continue;
    const span = { from: k + 1, to: stmtEnd(code, k + 1) };
    const pattern = code.slice(open, close + 1);
    if (m[1] === '{') {
      for (const name of bindingNames(pattern)) add(name, open, span, true);
      // `const { body, note: n } = o` — body получает род `o.body`, n — `o.note`.
      const from = pathKey(span);
      if (from) for (const [field, name] of patternFields(pattern)) links.push({ from: `${from}.${field}`, to: sc.key(name, open), fields: false });
      continue;
    }
    // `const [a, b] = await Promise.all([x, y])` — a получает x, b — y.
    const list = /^\s*(?:await\s+)?(?:Promise\s*\.\s*all(?:Settled)?\s*\(\s*)?\[/.exec(code.slice(span.from, span.to));
    const items = list ? argSpans(code, span.from + list[0].length - 1) : [];
    splitTop(pattern.slice(1, -1)).forEach((el, pos) => {
      for (const name of bindingNames(el)) add(name, open, items[pos] ?? span);
      // `const [first] = rows` — элемент несёт поля строк (двенадцатое ревью PR #3104).
      const single = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*$/.exec(el)?.[1];
      const from = single ? pathKey(items[pos] ?? span) : null;
      if (single && from) links.push({ from, to: sc.key(single, open), fields: true });
    });
  }
  // `for (const x of xs)` — x получает xs.
  FOR_OF.lastIndex = 0;
  for (let m = FOR_OF.exec(code); m; m = FOR_OF.exec(code)) {
    const paren = code.lastIndexOf('(', m.index + m[0].length);
    const close = closeOf(code, paren);
    const head = code.slice(m.index + m[0].length, close);
    const of = /\s+of\s+/.exec(head);
    if (!of) continue;
    const from = m.index + m[0].length + of.index + of[0].length;
    const pattern = head.slice(0, of.index).trim();
    const at = m.index + m[0].length;
    for (const name of bindingNames(pattern)) add(name, at, { from, to: close }, pattern.startsWith('{'));
    // Элемент — поля коллекции: `for (const l of list)` при `list.push({ note: … })`.
    const src = pathKey({ from, to: close });
    if (src && !pattern.startsWith('{') && !pattern.startsWith('[')) links.push({ from: src, to: sc.key(pattern, at), fields: true });
  }
  // Положили в коллекцию: `X.push(…)`, `X.set(k, v)` — X (и корень `box.lines`) получает аргументы.
  PUSH_CALL.lastIndex = 0;
  for (let m = PUSH_CALL.exec(code); m; m = PUSH_CALL.exec(code)) {
    const open = m.index + m[0].length - 1;
    const span = { from: open + 1, to: open + 1 + argsAfter(code, open).length };
    add(m[1], m.index, span);
    const root = chainRoot(code, m.index + m[1].length);
    if (root && root.name !== m[1]) add(root.name, root.at, span);
    // Положенный объект: его поля — поля коллекции (`list.push({ note: x })`; у `set` — второй аргумент).
    const args = argSpans(code, open);
    const value = /\.\s*set\s*\($/.test(m[0]) ? args[1] : args[0];
    if (value && !NOT_ROOT.has(m[1])) fieldsInto(sc.key(m[1], m.index), value);
  }
  // `Object.assign(target, …sources)` — цель получает источники и их поля
  // (тринадцатое ревью PR #3104: `Object.assign(payload, { phone: lead.phone })`).
  OBJECT_ASSIGN.lastIndex = 0;
  for (let m = OBJECT_ASSIGN.exec(code); m; m = OBJECT_ASSIGN.exec(code)) {
    const [target, ...sources] = argSpans(code, m.index + m[0].length - 1);
    const key = target ? pathKey(target) : null;
    if (!target || !key) continue;
    const name = key.slice(key.indexOf(':') + 1).split('.').slice(-1)[0];
    for (const source of sources) {
      edges.push({ key, name, span: source });
      fieldsInto(key, source);
    }
  }
  // Колбэк перебора: элемент получателя — его параметр.
  ITER_CALL.lastIndex = 0;
  for (let m = ITER_CALL.exec(code); m; m = ITER_CALL.exec(code)) {
    const recv = chainRoot(code, m.index);
    if (!recv) continue;
    const open = m.index + m[0].length - 1;
    const cb = argSpans(code, open)[0];
    if (!cb) continue;
    const pos = /^reduce/.test(m[1]) ? 1 : 0;
    // Отрезок — сам получатель до `.map`: `phones` — весь массив, `t.items` — поле.
    const recvSpan = { from: recv.at, to: m.index };
    const recvKey = pathKey(recvSpan);
    // Функция файла по ссылке (`leads.map(line)`): элемент — её параметр (восьмое ревью PR #3104).
    const ref = /^\s*(?:this\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(cb.from, cb.to))?.[1];
    if (ref && sc.functions.has(ref)) {
      for (const b of sc.functions.get(ref) ?? []) {
        for (const name of b.params[pos] ?? []) {
          edges.push({ key: `${b.scope}:${name}`, name, span: recvSpan });
          if (recvKey) links.push({ from: recvKey, to: `${b.scope}:${name}`, fields: true });
        }
      }
      continue;
    }
    const head = CALLBACK_HEAD.exec(code.slice(cb.from, cb.to));
    if (!head) continue;
    const params = head[1] !== undefined ? splitTop(head[1]) : [head[2]];
    const element = params[pos];
    if (!element) continue;
    const body = skipWs(code, cb.from + head.index + head[0].length - (head[3] === '{' ? 1 : 0));
    for (const name of bindingNames(element)) add(name, body, recvSpan);
    const single = /^\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?$/.exec(element)?.[1];
    if (recvKey && single) links.push({ from: recvKey, to: sc.key(single, body), fields: true });
  }
  // Аргумент вызова функции файла → её параметр (пятое ревью PR #3104: тонкая
  // обёртка `askModel(prompt)` над зарубежным вызовом прятала литерал-аргумент).
  // Метод файла и через чужой объект (`svc.describe(lead)`): чей он, страж не
  // знает, и связывает с методом файла того же имени (восьмое ревью PR #3104).
  const patterns = paramPatterns(code, sc);
  for (const re of [CALL_SITE, METHOD_SITE]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const fns = sc.functions.get(m[1]);
      if (!fns || /\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      if (re === METHOD_SITE && /\bthis\s*\??$/.test(code.slice(Math.max(0, m.index - 8), m.index))) continue;
      const open = m.index + m[0].length - 1;
      const args = argSpans(code, open);
      const close = args.length ? args[args.length - 1].to : open;
      // Заголовок функции или метода (`name(…) {`, `name(…): T {`, `(…) =>`) — не вызов.
      const k = skipWs(code, close + 1);
      if (code[k] === '{' || code.startsWith('=>', k) || (code[k] === ':' && afterReturnType(code, k + 1))) continue;
      for (const b of fns) {
        b.params.forEach((names, pos) => {
          const arg = args[pos];
          if (!arg) return;
          const pattern = patterns.get(b.scope)?.[pos]?.trim() ?? '';
          // Деструктурированный параметр (`({ body }) =>`) — чтение полей: поток
          // по ребру идёт, а род — только своего поля (`{ body: … }` или `opts.body`).
          const part = pattern.startsWith('{');
          for (const name of names) edges.push({ key: `${b.scope}:${name}`, name, span: arg, ...(part ? { part } : {}) });
          if (part) {
            const lb = skipWs(code, arg.from);
            const entries = code[lb] === '{' ? objectEntries(code, lb) : [];
            const from = pathKey(arg);
            for (const [field, name] of patternFields(pattern)) {
              const entry = entries.find((e) => e.key === field);
              if (entry) edges.push({ key: `${b.scope}:${name}`, name, span: entry.span });
              else if (from) links.push({ from: `${from}.${field}`, to: `${b.scope}:${name}`, fields: false });
            }
          } else if (names.length === 1) {
            // `ask({ body: lead.phone })` — род у `o.body`; `ask(opts)` — поля opts.
            fieldsInto(`${b.scope}:${names[0]}`, arg);
          }
        });
      }
    }
  }
  return edges;
}

/** Вызов метода через объект: `svc.describe(` — имя метода. */
const METHOD_SITE = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/** Тексты параметров по позиции — для области тела каждой функции. */
function paramPatterns(code: string, sc: Scopes): Map<number, string[]> {
  const out = new Map<number, string[]>();
  sc.params.forEach(([open, close], idx) => {
    const text = code[open] === '(' ? code.slice(open + 1, close) : code.slice(open + 1, close);
    out.set(sc.paramScopes[idx], splitTop(text));
  });
  return out;
}

/** Деструктуризация объекта: поле → связанное имя (`{ body, note: n }` → body→body, note→n). */
function patternFields(pattern: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const inner = pattern.trim().replace(/^\{/, '').replace(/\}\s*(?::[\s\S]*)?$/, '');
  for (const el of splitTop(inner)) {
    const e = el.trim();
    if (!e || e.startsWith('...')) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?(?:=[\s\S]*)?$/.exec(e);
    if (m) out.push([m[1], m[2] ?? m[1]]);
  }
  return out;
}

/** Стоки файла: значения `content:`/`system:`/…, аргументы зарубежной двери, правая часть переменной `*prompt*`. */
function seedsOf(code: string, edges: readonly Edge[], hasForeign: boolean): Seed[] {
  const seeds: Seed[] = [];
  // Сток `content:` и дверь — только в файле, говорящем с зарубежной моделью
  // (то же условие, что у метки `content`); переменная `*prompt*` — промпт везде.
  if (hasForeign) {
    SINK_KEY_HEAD.lastIndex = 0;
    for (let m = SINK_KEY_HEAD.exec(code); m; m = SINK_KEY_HEAD.exec(code)) {
      const from = m.index + m[0].length;
      seeds.push({ span: { from, to: from + valueAfter(code, from).length }, context: m[1] });
    }
    FOREIGN_CALL_HEAD.lastIndex = 0;
    for (let m = FOREIGN_CALL_HEAD.exec(code); m; m = FOREIGN_CALL_HEAD.exec(code)) {
      // Объявление самой функции (`async function callAIFast(prompt: string)`) — не вызов.
      if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
      const open = m.index + m[0].length - 1;
      seeds.push({ span: { from: open + 1, to: open + 1 + argsAfter(code, open).length }, context: m[1] });
    }
  }
  for (const e of edges) if (PROMPT_NAME.test(e.name)) seeds.push({ span: e.span, context: e.name, key: e.key });
  return seeds;
}

/** Отрезок без «дыр»: части [a, b), не покрытые ни одной дырой. */
function withoutHoles([a, b]: readonly [number, number], holes: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = a;
  for (const [h0, h1] of [...holes].sort((x, y) => x[0] - y[0])) {
    if (h1 <= at || h0 >= b) continue;
    if (h0 > at) out.push([at, h0]);
    at = Math.max(at, h1);
  }
  if (at < b) out.push([at, b]);
  return out;
}

/** Текст с затёртыми отрезками (длина и переводы строк те же). */
function blankAll(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const [a, b] of ranges) for (let k = Math.max(0, a); k < Math.min(b, chars.length); k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}

/** Бэктик-литералы кода верхнего уровня (с их `${…}`) — отрезками. */
function templateRanges(code: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i) - 1; continue; }
    if (c === '`') { const end = templateParts(code, i).end; out.push([i, end]); i = end - 1; }
  }
  return out;
}

/**
 * Параметры SQL-запроса (`pool.query(sql, [lead.phone])`): аргументы после
 * первого. Это значения для сервера базы, в текст строк результата они не
 * попадают (CLAUDE.md §4) — родом ПД результат не метят.
 */
const QUERY_CALL = /\.\s*query\s*(?:<[\s\S]*?>\s*)?\(/g;
function queryParamRanges(code: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  QUERY_CALL.lastIndex = 0;
  for (let m = QUERY_CALL.exec(code); m; m = QUERY_CALL.exec(code)) {
    const args = argSpans(code, m.index + m[0].length - 1);
    if (args.length > 1) out.push([args[1].from, args[args.length - 1].to]);
  }
  return out;
}

/**
 * Роды ПД строки результата по тексту запроса (одиннадцатое ревью PR #3104):
 * `JSON.stringify(rows)` кладёт в промпт всю строку, и поля в коде не названы.
 * Род даёт список колонок: `tourist_phone` — контакт, `passport` — идентификатор,
 * `tourist_name` — имя, голое `name` — имя, если его таблица — люди (лиды,
 * брони, пользователи); `*` — все роды: что в строке, не видно. Колонки без ПД
 * (`title`, `note`) рода не дают — сериализация названий туров чиста.
 *
 * Двенадцатое ревью: род колонки — по ВСЕМУ выражению, а не по выходному
 * имени. `tourist_phone::text` выходит полем `text`, `tourist_name AS title` —
 * полем `title`, `COALESCE(telegram_chat_id::text, telegram_id::text) AS tg` —
 * `tg`, и по имени все три чисты. Поэтому снимаются приведения `::тип`,
 * строки и подсчёты (`COUNT(phone)`, `phone IS NULL` — число и признак, а не
 * контакт), и судится каждый идентификатор выражения и псевдоним. Голое
 * `name` с владельцем судится по таблице владельца: `t.name` тура рядом с
 * присоединёнными лидами — название тура, `l.name` — имя.
 *
 * Поля строки — тоже: `rows[0].name`, `first.tourist_phone` читают одно поле,
 * и его род — род его колонки (`fields`), а не всей строки; `rows[0].title`
 * рядом с телефоном чист.
 */
const PERSONAL_NAME_COLUMN = new RegExp(`^${PERSONAL_NAME_FIELD.source.replace(/\\b/g, '')}$`, 'i');
/** Слова после таблицы, которые псевдонимом не бывают. */
const SQL_NOT_ALIAS: ReadonlySet<string> = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'on', 'using', 'group', 'order',
  'limit', 'offset', 'having', 'union', 'lateral', 'window', 'for', 'returning', 'as', 'and', 'or', 'set', 'values',
  'except', 'intersect', 'end', 'null', 'true', 'false', 'asc', 'desc',
]);

export interface SqlRowShape {
  /** Роды строки целиком (`JSON.stringify(row)`). */
  kinds: Kind[];
  /** Роды полей строки по выходному имени колонки. */
  fields: Map<string, Kind[]>;
}

/**
 * Текст SQL без строк и комментариев той же длины: `'from web'` и
 * `/* from cache *\/` не обрывают список колонок (тринадцатое ревью PR #3104).
 */
function maskSql(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      out += "'" + ' '.repeat(Math.max(0, j - i - 1)) + (j < text.length ? "'" : '');
      i = j;
    } else if (c === '-' && text[i + 1] === '-') {
      const j = text.indexOf('\n', i);
      const end = j < 0 ? text.length : j;
      out += ' '.repeat(end - i);
      i = end - 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j < 0 ? text.length : j + 2;
      out += ' '.repeat(end - i);
      i = end - 1;
    } else out += c;
  }
  return out;
}

/** Строка целиком в одной колонке: `row_to_json(l)`, `to_jsonb(l)`, `json_agg(l)`, `json_agg(l.*)`. */
const WHOLE_ROW = /\b(?:row_to_json|to_jsonb?|jsonb?_agg|array_agg|jsonb?_build_array|row)\s*\(\s*(?:distinct\s+)?([A-Za-z_]\w*)(\s*\.\s*\*)?\s*(?=[),]|order\b)/gi;

export function sqlRow(sql: string): SqlRowShape {
  const text = sql.replace(/^[\s'"`]+|[\s'"`]+$/g, '');
  // Строки и комментарии затёрты: `FROM` ищется только в коде запроса.
  const plain = maskSql(text);
  const head = /\bselect\b/i.exec(plain);
  if (!head) return { kinds: [], fields: new Map() };
  let depth = 0;
  let end = -1;
  for (let i = head.index + head[0].length; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\bfrom\b/i.test(plain.slice(i, i + 5)) && /\W/.test(plain[i - 1] ?? ' ')) { end = i; break; }
  }
  const listFrom = head.index + head[0].length;
  const listTo = end < 0 ? plain.length : end;
  // Таблицы и их псевдонимы: `FROM leads l JOIN users u` — l → leads, u → users.
  const tables = new Map<string, string>();
  if (end >= 0) {
    for (const m of plain.slice(end).matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi)) {
      const table = m[1].split('.').slice(-1)[0];
      tables.set(table.toLowerCase(), table);
      if (m[2] && !SQL_NOT_ALIAS.has(m[2].toLowerCase())) tables.set(m[2].toLowerCase(), table);
    }
  }
  const anyPerson = [...tables.values()].some((t) => PERSON_WORD.test(t));
  /** Владелец голого `name` — люди: таблица по псевдониму; без владельца или неизвестный — любая таблица запроса. */
  const personOwner = (q: string | undefined): boolean => {
    if (!q) return anyPerson;
    const t = tables.get(q.toLowerCase());
    return t !== undefined ? PERSON_WORD.test(t) : PERSON_WORD.test(q) || anyPerson;
  };
  // Колонки — по запятым верхнего уровня в коде; рядом — тот же отрезок исходника (ключи `->>'phone'`).
  const cols: Array<{ code: string; raw: string }> = [];
  depth = 0;
  let start = listFrom;
  for (let i = listFrom; i <= listTo; i++) {
    const ch = plain[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (i === listTo || (ch === ',' && depth === 0)) { cols.push({ code: plain.slice(start, i), raw: text.slice(start, i) }); start = i + 1; }
  }
  const kinds = new Set<Kind>();
  const fields = new Map<string, Kind[]>();
  for (const { code: codeCol, raw } of cols) {
    const col = codeCol.trim().replace(/^distinct\s+(?:on\s*\((?:[^()]|\([^()]*\))*\)\s*)?/i, '');
    if (!col) continue;
    const star = /^(?:([A-Za-z_]\w*)\s*\.\s*)?\*$/.exec(col);
    if (star) {
      for (const k of KINDS) kinds.add(k);
      // Поля `*` не названы; `.phone`, `.address` судит шаблон поля, а `.name` — здесь.
      if (personOwner(star[1])) fields.set('name', ['name']);
      continue;
    }
    // Псевдоним: `expr AS x` или `expr x` (после имени, скобки, кавычки).
    const asM = /\s+as\s+"?([A-Za-z_]\w*)"?\s*$/i.exec(col);
    const implicit = asM ? null : /([\w)"'\]])\s+"?([A-Za-z_]\w*)"?\s*$/.exec(col);
    const alias = asM?.[1] ?? (implicit && !SQL_NOT_ALIAS.has(implicit[2].toLowerCase()) ? implicit[2] : null);
    const exprRaw = asM ? col.slice(0, asM.index) : alias && implicit ? col.slice(0, implicit.index + 1) : col;
    // Строки уже затёрты (`maskSql`): слово в кавычках колонкой не считается.
    const expr = exprRaw
      .replace(/::\s*"?[A-Za-z_]\w*"?(?:\s*\([\d\s,]*\))?(?:\s*\[\s*\])*/g, '')
      .replace(/\bcount\s*\((?:[^()]|\([^()]*\))*\)/gi, '0')
      .replace(/(?:[A-Za-z_]\w*\s*\.\s*)?"?[A-Za-z_]\w*"?\s+is\s+(?:not\s+)?null\b/gi, 'true');
    const colKinds = new Set<Kind>();
    const judge = (id: string, owner: string | undefined, isAlias: boolean) => {
      if (isRedactableId(id)) colKinds.add('contact');
      if (isIdentId(id)) colKinds.add('ident');
      if (isPersonNameId(id)) colKinds.add('name');
      if (!isAlias && /^name$/i.test(id) && personOwner(owner)) colKinds.add('name');
    };
    for (const m of expr.matchAll(/(?:\b([A-Za-z_]\w*)\s*\.\s*)?"?\b([A-Za-z_]\w*)\b"?(?!\s*\()/g)) judge(m[2], m[1], false);
    // Ключ поля JSON — тоже колонка: `source_data->>'phone'`, `to_jsonb(l)->'name'`.
    for (const m of raw.matchAll(/->>?\s*'([A-Za-z_]\w*)'/g)) judge(m[1], undefined, false);
    // Строка целиком в колонке — все роды, как `*`; имя — если строка людей.
    let wholeOwner: string | null = null;
    for (const m of expr.matchAll(WHOLE_ROW)) {
      if (m[2] || tables.has(m[1].toLowerCase())) { wholeOwner = m[1]; break; }
    }
    const starIn = wholeOwner ? null : /\b([A-Za-z_]\w*)\s*\.\s*\*/.exec(expr);
    if (starIn) wholeOwner = starIn[1];
    if (wholeOwner) for (const k of KINDS) colKinds.add(k);
    // Псевдоним признака и подсчёта (`phone IS NOT NULL AS has_phone`) — не контакт.
    if (alias && !/^\s*(?:true|0)\s*$/.test(expr)) judge(alias, undefined, true);
    // Выходное имя: псевдоним; `t.col` и `col::text` — col; вызов — имя функции.
    const bare = /^\s*(?:[A-Za-z_]\w*\s*\.\s*)?"?([A-Za-z_]\w*)"?\s*$/.exec(expr);
    const call = /^\s*([A-Za-z_]\w*)\s*\(/.exec(expr);
    const field = alias ?? bare?.[1] ?? call?.[1].toLowerCase() ?? null;
    if (colKinds.size === 0) continue;
    for (const k of colKinds) kinds.add(k);
    if (field) fields.set(field, [...new Set([...(fields.get(field) ?? []), ...colKinds])]);
    if (field && wholeOwner && personOwner(wholeOwner)) fields.set(`${field}.name`, ['name']);
  }
  return { kinds: [...kinds], fields };
}

export const sqlRowKinds = (sql: string): Kind[] => sqlRow(sql).kinds;

/** Вызов запроса с текстом SQL первым аргументом: `pool.query(…)`, `client.query<T>(…)`, `query(…)`. */
const QUERY_AT = /(?:^|[^\w$])(?:\.\s*)?query\s*(?:<[^()]*?>\s*)?\(/g;
/**
 * Объявление, которому присвоен результат: `const { rows } =`, `const [row] =`,
 * `const res =`, `const list: T[] =`; после `=` — `await`, открывающие скобки
 * (`(await pool.query(…)).rows`) и получатель.
 */
const QUERY_DECL = /\b(?:const|let|var)\s+(\{[^{}]*\}|\[[^[\]]*\]|[A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*((?:\(\s*|await\s+)*)(?:[A-Za-z_$][\w$]*\s*\??\.\s*)*$/;

/** После `at` выражение кончилось: дальше не поле, не элемент и не вызов. */
const exprEnds = (code: string, at: number): boolean => {
  const k = skipWs(code, at);
  return !/^(?:\??\.|\[|\()/.test(code.slice(k, k + 2));
};

/**
 * Переменные с результатом запроса и роды ПД его строки и полей: `{ rows }`,
 * `{ rows: [row] }`, `[row]` — строки; `res` — сам результат, его `res.rows` и
 * поля `res.rows[0].name`; `(await pool.query(…)).rows` и `….rows[0]` —
 * строки и строка (двенадцатое ревью PR #3104). Текст SQL — из исходника: в
 * маске он затёрт. Запрос, собранный в переменную, сюда не попадает —
 * ограничение названо.
 */
function queryResults(src: string, code: string, sc: Scopes): Array<{ key: string; kinds: Kind[] }> {
  const out: Array<{ key: string; kinds: Kind[] }> = [];
  QUERY_AT.lastIndex = 0;
  for (let m = QUERY_AT.exec(code); m; m = QUERY_AT.exec(code)) {
    const open = m.index + m[0].length - 1;
    const first = argSpans(code, open)[0];
    if (!first) continue;
    const sql = src.slice(first.from, first.to).trim();
    if (!/^['"`]/.test(sql)) continue;
    const row = sqlRow(sql);
    if (row.kinds.length === 0) continue;
    // Начало имени `query`: перед ним — получатель (`pool.`), `await` и скобки.
    const qPos = m.index + m[0].indexOf('query');
    const before = code.slice(Math.max(0, qPos - 240), qPos);
    const t = QUERY_DECL.exec(before);
    if (!t) continue;
    // Скобки, открытые до вызова, закрываются после него: `(await q(…)).rows`.
    let j = closeOf(code, open) + 1;
    let balanced = true;
    for (let n = (t[2].match(/\(/g) ?? []).length; n > 0; n--) {
      j = skipWs(code, j);
      if (code[j] !== ')') { balanced = false; break; }
      j++;
    }
    if (!balanced) continue;
    let shape: 'result' | 'rows' | null = exprEnds(code, j) ? 'result' : null;
    const rows = shape ? null : /^\s*\??\.\s*rows\b/.exec(code.slice(j, j + 40));
    if (rows) {
      j += rows[0].length;
      // Элемент строк — та же строка: `.rows[0]`, `.rows.at(-1)`, `!`.
      for (let guard = 0; guard < 8; guard++) {
        const k = skipWs(code, j);
        if (code[k] === '!' && code[k + 1] !== '=') { j = k + 1; continue; }
        if (code[k] === '[') { j = closeOf(code, k) + 1; continue; }
        const atCall = /^\??\.\s*at\s*\(/.exec(code.slice(k, k + 12));
        if (atCall) { j = closeOf(code, k + atCall[0].length - 1) + 1; continue; }
        break;
      }
      if (exprEnds(code, j)) shape = 'rows';
    }
    if (!shape) continue;
    const at = qPos - before.length + t.index + t[0].indexOf(t[1]);
    const put = (key: string) => {
      out.push({ key, kinds: row.kinds });
      for (const [f, k] of row.fields) out.push({ key: `${key}.${f}`, kinds: k });
    };
    const target = t[1];
    if (target.startsWith('{')) {
      if (shape !== 'result') continue;
      for (const part of splitTop(target.slice(1, -1))) {
        const d = /^\s*rows\s*(?::\s*([A-Za-z_$][\w$]*|\[[^\]]*\]))?\s*$/.exec(part);
        if (!d) continue;
        if (d[1]?.startsWith('[')) for (const name of bindingNames(d[1])) put(sc.key(name, at));
        else put(sc.key(d[1] ?? 'rows', at));
      }
    } else if (target.startsWith('[')) {
      for (const name of bindingNames(target)) put(sc.key(name, at));
    } else {
      const key = sc.key(target, at);
      put(key);
      // Результат целиком: строки у него в `.rows`.
      if (shape === 'result') put(`${key}.rows`);
    }
  }
  return out;
}

/**
 * Что несёт обращение к переменной, имя которой кончается на `end` (цепочка —
 * не дальше `limit`): весь объект (`field: null`) — сам `x`, элемент `x[0]`,
 * методы `x.join()`; поле (`field: 'prop'`) — `x.prop`, за которым метод,
 * индекс или конец, поле поля — путь (`x.rows[0].name` — `rows.name`);
 * ничего (null) — `x.map((a) => …)`, где результат собирает колбэк и судится
 * он сам.
 *
 * Поле объекта не несёт рода всего объекта: строка из базы, где рядом с
 * названием тура лежит имя автора, делала бы «именем» и название
 * (`review.tour_name`). Поле ПД (`.phone`, `.user_name`) судит шаблон поля, а
 * поле, куда ПД положили (`box.value = lead.phone`), — свой род (`box.value`).
 */
function carrierOf(
  code: string, end: number, limit = code.length, fns?: ReadonlyMap<string, unknown>,
): { field: string | null } | null {
  let i = end;
  let field: string | null = null;
  for (let guard = 0; guard < 64; guard++) {
    i = skipWs(code, i);
    if (i >= limit) break;
    if (code[i] === '!' && code[i + 1] !== '=') { i++; continue; }
    let optional = false;
    if (code[i] === '?' && code[i + 1] === '.') { i += 2; optional = true; }
    if (code[i] === '[' || code[i] === '(') { i = closeOf(code, i) + 1; continue; }
    if (!optional) {
      if (code[i] !== '.' || code[i + 1] === '.') break;
      i++;
    }
    const id = /^\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 80));
    if (!id) break;
    i += id[0].length;
    const k = skipWs(code, i);
    const open = code[k] === '(' ? k : code[k] === '?' && code[k + 1] === '.' && code[k + 2] === '(' ? k + 2 : -1;
    if (open >= 0) {
      // `x.map((a) => a.title)`, `x.map(line)` с функцией файла — результат
      // собирает колбэк, и судится он сам.
      if (TRANSFORMS.has(id[1])) {
        const arg = code.slice(open + 1, open + 200);
        const ref = /^\s*(?:this\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*[,)]/.exec(arg)?.[1];
        if (CALLBACK_HEAD.test(arg) || (ref && fns?.has(ref))) return null;
      }
      continue;
    }
    // Поле поля — путь (`res.rows[0].name` — `rows.name`): род у него только
    // тот, что ему записали (поля строки запроса), иначе — никакой.
    field = field === null ? id[1] : `${field}.${id[1]}`;
  }
  return { field };
}

/** Ключ рода, который несёт обращение: переменная или её поле (`ключ.поле`); null — ничего. */
function carrierKey(code: string, r: Root, sc: Scopes, limit: number): string | null {
  const c = carrierOf(code, r.at + r.name.length, limit, sc.functions);
  if (!c) return null;
  const key = sc.key(r.name, r.at);
  return c.field === null ? key : `${key}.${c.field}`;
}

/** Обращение — весь объект (не поле): `tourist_phone`, `tourist_phone.trim()`, но не `tourist_phone.length`. */
const wholeUse = (code: string, r: Root, limit: number): boolean => carrierOf(code, r.at + r.name.length, limit)?.field === null;

/** Методы, чей результат собирает колбэк, а не сам получатель. */
const TRANSFORMS = new Set(['map', 'flatMap', 'reduce', 'reduceRight']);

/**
 * Род ПД переменных и функций файла — пришедший не через шаблон и не через
 * сток. ПД в `${…}` литерала в потоке судит сам литерал, ПД в стоке — сам
 * сток (`sinkFindings`); род, несомый дальше, судится там, где переменная
 * входит в следующий литерал или сток. Одна утечка — одна находка, а не по
 * находке на каждом звене цепочки.
 */
interface Taints {
  vars: Map<string, Set<Kind>>;
  fns: Map<string, Set<Kind>>;
}

/**
 * Однобуквенный владелец `.name` (`l.name`, `b.name`, `m.name`) — человек,
 * пока не доказано обратное: одно правило и для `${l.name}` в промпте, и для
 * имени, унесённого в переменную. Не человек — только владелец, связанный с
 * не-человеком: колбэк перебора моделей (`(data.models ?? []).map((m) =>
 * m.name)`), параметр с таким типом (`b: Buffer`), `for (const m of models)`.
 *
 * Девятое ревью PR #3104: седьмая правка требовала обратного — доказать
 * человека (перебор лидов, тип `Booking`), и выборка под нейтральным именем
 * (`rows.map((l) => l.name)`, `b: { name: string }`) проходила молча, хотя до
 * PR и прямо в `${…}` это имя. Неизвестный владелец — «не знаю», а «не знаю»
 * здесь судится как имя (§4.0): краснота с названной строкой лучше пропуска.
 *
 * Не-человека называет главное слово идентификатора — последнее после
 * разбиения по `_` и camelCase: `models`, `geminiModels`, `Blob`. Подстрока
 * не годится (десятое ревью): `file` сидит внутри `profiles`, `tool` — внутри
 * `toolkit`, и выборка профилей сходила бы за файлы. Слова берутся только из
 * имён самой цепочки-получателя, типа и коллекции `for…of`: аргументы и
 * колбэки вызовов (`filter((p) => p.avatarFile)`) и поля объектного типа
 * (`{ file: string }`) говорят не о том, что перебирается.
 *
 * Главные слова не-людей — `NON_PERSON_HEAD`, у каждого причина: `model` —
 * имена моделей в каталоге провайдера; `buffer`, `blob`, `file` — имя файла;
 * `tool` — имя инструмента модели. Слово человека в любом из этих имён
 * (`leadFiles`) сильнее: владелец остаётся человеком.
 */
const PERSON_WORD = /lead|booking|user|member|guest|client|customer|tourist|travel|passenger|buyer|payer|participant|person|people/i;
const NON_PERSON_HEAD: ReadonlySet<string> = new Set(['model', 'models', 'buffer', 'buffers', 'blob', 'blobs', 'file', 'files', 'tool', 'tools']);
const SINGLE_OWNER_NAME = /\b([lbumg])\s*\.\s*name\b/g;
const PERSONAL_OWNER_LONG = new RegExp(PERSONAL_OWNER_NAME.source.replace(/\|[lbumg](?=\|)/g, ''), 'i');

/** Слова идентификатора: `geminiModels` → gemini, models; `XMLFile` → xml, file; `tool_calls` → tool, calls. */
function identWords(id: string): string[] {
  return (id.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
}

/** Имена говорят о не-человеке: главное слово одного из них — из `NON_PERSON_HEAD`, слова человека нет ни в одном. */
function nonPersonIdents(ids: readonly string[]): boolean {
  if (ids.some((id) => PERSON_WORD.test(id))) return false;
  return ids.some((id) => NON_PERSON_HEAD.has(identWords(id).slice(-1)[0] ?? ''));
}

/** Имена верхнего уровня: содержимое скобок `()`, `[]`, `{}` — аргументы, индексы, поля типа — не берётся. */
function topIdents(text: string): string[] {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    out += depth === 0 ? ch : ' ';
    if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
  }
  return out.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/**
 * Имена цепочки-получателя, кончающейся на `end`: `rows`; `m`, `newLeads`;
 * у `(data.models ?? []).filter(…)` — `filter` и имена группы `data`, `models`.
 * Аргументы вызовов и индексы — не имена получателя.
 */
function receiverIdents(code: string, end: number): string[] {
  const ws = (k: number) => { while (k > 0 && /\s/.test(code[k - 1])) k--; return k; };
  const ids: string[] = [];
  let i = end;
  for (;;) {
    const j = ws(i);
    if (code[j - 1] === ')' || code[j - 1] === ']') {
      const o = openOf(code, j - 1);
      if (o < 0) break;
      i = o;
      // Скобки вызова или индекса — цепочка идёт дальше; группа `(a ?? b)` — её начало.
      if (!/[\w$)\]]/.test(code[ws(o) - 1] ?? '')) {
        ids.push(...topIdents(code.slice(o + 1, j - 1)));
        break;
      }
      continue;
    }
    const id = identBefore(code, j);
    if (!id) break;
    ids.push(id);
    i = j - id.length;
    const k = ws(i);
    if (code[k - 1] !== '.' || code[k - 2] === '.') break;
    i = code[k - 2] === '?' ? k - 2 : k - 1;
  }
  return ids;
}

/** Ключи однобуквенных владельцев, доказуемо связанных с не-человеком. */
function nonPersonKeys(code: string, sc: Scopes): Set<string> {
  const out = new Set<string>();
  const mark = (names: string[], key: (n: string) => string) => { for (const n of names) if (/^[lbumg]$/.test(n)) out.add(key(n)); };
  ITER_CALL.lastIndex = 0;
  for (let m = ITER_CALL.exec(code); m; m = ITER_CALL.exec(code)) {
    if (!nonPersonIdents(receiverIdents(code, m.index))) continue;
    const open = m.index + m[0].length - 1;
    const cb = argSpans(code, open)[0];
    const head = cb && CALLBACK_HEAD.exec(code.slice(cb.from, cb.to));
    if (!cb || !head) continue;
    const params = head[1] !== undefined ? splitTop(head[1]) : [head[2]];
    const body = skipWs(code, cb.from + head.index + head[0].length - (head[3] === '{' ? 1 : 0));
    mark(bindingNames(params[/^reduce/.test(m[1]) ? 1 : 0] ?? ''), (n) => sc.key(n, body));
  }
  sc.params.forEach(([open, close], idx) => {
    for (const part of splitTop(code.slice(open + 1, close))) {
      const typed = /^\s*([lbumg])\s*\??\s*:\s*([^=]+)/.exec(part);
      if (typed && nonPersonIdents(topIdents(typed[2]))) out.add(`${sc.paramScopes[idx]}:${typed[1]}`);
    }
  });
  FOR_OF.lastIndex = 0;
  for (let m = FOR_OF.exec(code); m; m = FOR_OF.exec(code)) {
    const paren = code.lastIndexOf('(', m.index + m[0].length);
    const head = code.slice(m.index + m[0].length, closeOf(code, paren));
    const of = /\s+of\s+/.exec(head);
    const coll = of ? head.slice(of.index + of[0].length).trim().replace(/^\(([\s\S]*)\)$/, '$1') : '';
    if (of && nonPersonIdents(topIdents(coll))) mark(bindingNames(head.slice(0, of.index)), (n) => sc.key(n, m.index + m[0].length));
  }
  return out;
}

/** Имя человека в тексте с позиции `base`: поле `*_name`, `lead.name`; однобуквенный владелец — если не доказан не-человеком. */
function personNameIn(text: string, base: number, sc: Scopes, nonPerson: ReadonlySet<string>): boolean {
  if (identRefs(text, isPersonNameId).length > 0 || PERSONAL_OWNER_LONG.test(text)) return true;
  for (const m of text.matchAll(SINGLE_OWNER_NAME)) if (!nonPerson.has(sc.key(m[1], base + (m.index ?? 0)))) return true;
  return false;
}

/**
 * Аргументы ожидаемых вызовов файла (`await x.get(…)`) — выборки, чей результат
 * найден по ключу. `await Promise.all([get(…), …])` накрывает свои элементы.
 */
function awaitedArgRanges(code: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\bawait\s+(?:[A-Za-z_$][\w$]*\s*\??\.\s*)*[A-Za-z_$][\w$]*\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length - 1;
    out.push([open, closeOf(code, open)]);
  }
  return out;
}

const KINDS: readonly Kind[] = ['contact', 'name', 'ident'];
/** Предел длины пути поля (`S:x.a.b.c.d`): глубже поля в коде не читаются. */
const MAX_PATH = 6;
type KindDeps = { stat: boolean; vars: string[]; fns: string[] };

/**
 * Что даёт отрезку род ПД: поле, переменная с именем контакта (`stat`),
 * переменные и функции файла, род которых ещё может прийти. Аргументы вызова
 * функции файла сюда не входят: они идут в её параметры ребром, и род
 * результата — это род того, что она возвращает.
 */
function depsOf(
  text: string, span: FlowSpan, sc: Scopes, own: ReadonlySet<string>, nonPerson: ReadonlySet<string>,
  keysIn: ReadonlyArray<[number, number]> = [],
): Record<Kind, KindDeps> {
  const opaque = ownCallArgRanges(text, span.from, span.to, own);
  const clean = [...sanitizedRanges(text, span.from, span.to, CONTACT_SANITIZERS), ...opaque];
  const evC = blankRanges(text.slice(span.from, span.to), span.from, clean).replace(SERVICE_CONTACT, (m) => ' '.repeat(m.length));
  const evN = blankRanges(text.slice(span.from, span.to), span.from, opaque);
  const notParam = (r: Root) => !insideAny(r.at, sc.params);
  const rc = rootsAt(text, span.from, span.to, CONTACT_SANITIZERS, [], false, own).filter(notParam);
  const rn = rootsAt(text, span.from, span.to, NO_SANITIZERS, [], false, own).filter(notParam);
  const ri = rn.filter((r) => !(insideAny(r.at, keysIn) && isIdentId(r.name) && wholeUse(text, r, span.to)));
  const keys = (roots: Root[]) => roots.map((r) => carrierKey(text, r, sc, span.to)).filter((k): k is string => k !== null);
  // Вызов функции файла и она же по ссылке (`leads.map(line)`) — род её возврата.
  const ownCalls = (cutters: ReadonlySet<string>, roots: Root[]) => [
    ...literalsIn(text, span, cutters, own).callees.filter((n) => own.has(n)),
    ...roots.filter((r) => own.has(r.name)).map((r) => r.name),
  ];
  return {
    contact: {
      stat: fieldRefs(evC, isRedactableId).length > 0 || rc.some((r) => isRedactableId(r.name) && wholeUse(text, r, span.to)),
      vars: keys(rc),
      fns: ownCalls(CONTACT_SANITIZERS, rc),
    },
    name: {
      stat: personNameIn(evN, span.from, sc, nonPerson),
      vars: keys(rn),
      fns: ownCalls(NO_SANITIZERS, rn),
    },
    // Адрес, документ, мессенджер — чистка их не гасит: судятся без неё.
    // Переменная-идентификатор, отданная ключом в ожидаемый вызов
    // (`await getHistory(chatId)`), результат не метит: выборка по ключу
    // возвращает найденное, а не ключ. Сам ключ в тексте (`${chatId}`,
    // `String(chatId)`) судится, где стоит.
    ident: {
      stat: fieldRefs(evN, isIdentId).length > 0 || ri.some((r) => isIdentId(r.name) && wholeUse(text, r, span.to)),
      vars: keys(ri),
      fns: ownCalls(NO_SANITIZERS, ri),
    },
  };
}

/**
 * Род ПД по рёбрам потока до неподвижной точки.
 *
 * Дайджест платформы годами отдавал зарубежной модели «имя | телефон» лида:
 * ПД шли через локальные переменные в два шага (`l.phone` → `phone` → строка →
 * промпт), и правило, искавшее только прямое `l.phone`, давало ложное «чисто».
 * До 07.11 род ходил только через `${…}` объявлений; седьмое ревью PR #3104
 * показало, что параметр (`ask(lead.phone)`), поле (`this.ctx = lead.phone`) и
 * голое `const b = a` его теряли. Теперь род идёт по тем же рёбрам, что поток.
 *
 * Область — по ключам областей видимости: `text` уведомления оператору и
 * `text` вопроса туриста в соседней функции — разные переменные
 * (`lib/kuzmich/core.ts`). Улика — обращение в коде, не текст строки: SQL
 * `u.name as user_name` в строке запроса результат не метит (поле `user_name`
 * при чтении судит шаблон поля), параметры запроса (`[lead.phone]`) — тоже.
 *
 * Чем род не переносится — и почему (перепись 07.11 дала бы десятки ложных
 * находок): чтение поля (`t.title`, `const { text } = opts`) несёт род поля,
 * не объекта (`carrierOf`); `x.map((a) => …)` несёт то, что вернул колбэк;
 * однобуквенный владелец `m.name` — имя, только если связан с человеком
 * (`personKeys`); пустые скобки `string[]` — тип, а не элемент.
 */
function taintsIn(code: string, sc: Scopes, edges: readonly Edge[], seeds: readonly Seed[], links: readonly Link[] = [], src: string | null = null): Taints {
  const qp = queryParamRanges(code);
  const own = new Set(sc.functions.keys());
  // Сток судит себя сам, кроме аргументов функций файла: они уходят в её
  // параметры (`content: describe(lead.phone)`), и род там нужен.
  const seedRanges = seeds.flatMap((s) => withoutHoles([s.span.from, s.span.to], ownCallArgRanges(code, s.span.from, s.span.to, own)));
  const templates = templateRanges(code);
  // Код без шаблонов и стоков: что в них, судят они сами.
  const text = blankAll(blankAll(blankAll(code, qp), templates), seedRanges);
  const fnSpans = [...sc.functions].flatMap(([name, bodies]) => bodies.flatMap((b) => returnSpans(code, b, sc.bodies)).map((span) => ({ name, span })));

  const vars = new Map<string, Set<Kind>>();
  const fns = new Map<string, Set<Kind>>();
  // Поля по основе: `S:o` → {body, note} — для связей «поля в поля».
  const fieldsOf = new Map<string, Set<string>>();
  const mark = (m: Map<string, Set<Kind>>, k: string, kind: Kind) => {
    const set = m.get(k) ?? new Set<Kind>();
    set.add(kind);
    m.set(k, set);
    // Поле пути — поле каждой его основы: `S:res.rows.name` — `rows.name` у
    // `S:res` и `name` у `S:res.rows`.
    if (m === vars) {
      for (let dot = k.indexOf('.'); dot > 0; dot = k.indexOf('.', dot + 1)) {
        const base = k.slice(0, dot);
        fieldsOf.set(base, (fieldsOf.get(base) ?? new Set()).add(k.slice(dot + 1)));
      }
    }
  };
  const has = (m: Map<string, Set<Kind>>, k: string, kind: Kind) => m.get(k)?.has(kind) ?? false;
  // Деструктурированный контакт (`const { phone: tel } = lead`) — по имени поля.
  DESTRUCT.lastIndex = 0;
  for (let m = DESTRUCT.exec(code); m; m = DESTRUCT.exec(code)) {
    for (const part of m[1].split(',')) {
      const d = DESTRUCT_CONTACT.exec(part);
      if (d && isRedactableId(d[1])) mark(vars, sc.key(d[2] ?? d[1], m.index), 'contact');
      else if (d && isIdentId(d[1])) mark(vars, sc.key(d[2] ?? d[1], m.index), 'ident');
    }
  }
  // Строка из базы целиком (`JSON.stringify(rows)`) — род по колонкам запроса.
  if (src !== null) for (const q of queryResults(src, code, sc)) for (const kind of q.kinds) mark(vars, q.key, kind);
  const nonPerson = nonPersonKeys(code, sc);
  const keysIn = awaitedArgRanges(text);
  const eDeps = edges.filter((e) => !e.part).map((e) => ({ key: e.key, d: depsOf(text, e.span, sc, own, nonPerson, keysIn) }));
  const fDeps = fnSpans.map((f) => ({ name: f.name, d: depsOf(text, f.span, sc, own, nonPerson, keysIn) }));
  const fires = (d: Record<Kind, KindDeps>, kind: Kind) =>
    d[kind].stat || d[kind].vars.some((k) => has(vars, k, kind)) || d[kind].fns.some((n) => has(fns, n, kind));
  // Цепочки в коде короткие; предел — от патологии.
  for (let pass = 0; pass < 20; pass++) {
    let grew = false;
    for (const kind of KINDS) {
      for (const { key, d } of eDeps) if (!has(vars, key, kind) && fires(d, kind)) { mark(vars, key, kind); grew = true; }
      for (const { name, d } of fDeps) if (!has(fns, name, kind) && fires(d, kind)) { mark(fns, name, kind); grew = true; }
      for (const l of links) {
        if (!l.fields) {
          if (has(vars, l.from, kind) && !has(vars, l.to, kind)) { mark(vars, l.to, kind); grew = true; }
          continue;
        }
        for (const f of fieldsOf.get(l.from) ?? []) {
          // Путь длиннее MAX_PATH не растёт: связь поля с предком (`a.b = a`) иначе удлиняла бы его на каждом проходе.
          if (`${l.to}.${f}`.split('.').length > MAX_PATH) continue;
          if (has(vars, `${l.from}.${f}`, kind) && !has(vars, `${l.to}.${f}`, kind)) { mark(vars, `${l.to}.${f}`, kind); grew = true; }
        }
      }
    }
    if (!grew) break;
  }
  return { vars, fns };
}

/**
 * Конец выражения от `from` (правая часть присваивания, `return`): `;` или
 * непарная скобка на нулевой вложенности. Перевод строки заканчивает
 * выражение, только если оно уже началось, строка не кончается оператором
 * (`+`, `=`, `(`, `,`, `?`, `:`, `&&`, `.`, `=>`) и следующая не начинается с
 * него. Строки и бэктики пропускаются целиком.
 *
 * Четвёртое ревью PR #3104: прежняя граница обрывалась на первом переводе
 * строки, и у `const prompt =` ⏎ `\`…\` +` ⏎ `\`Почта: ${user.email}\`` в поток
 * не попадал ни один литерал после первого (так записан, например,
 * lib/agents/platform-agent.ts).
 */
function stmtEnd(code: string, from: number): number {
  let depth = 0;
  let begun = false;
  let i = from;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); begun = true; continue; }
    if (c === '`') { i = templateParts(code, i).end; begun = true; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if (c === ';' && depth === 0) return i;
    else if (c === '\n' && depth === 0 && begun) {
      let j = i - 1;
      while (j >= from && /\s/.test(code[j])) j--;
      const lineEndsWithOperator = j >= from && /[+\-*/%&|?:=,([{.<>^]/.test(code[j]);
      const nextStartsWithOperator = /^\s*(?:[.?:|&+\-*/%,]|=>)/.test(code.slice(i + 1, i + 200));
      if (!lineEndsWithOperator && !nextStartsWithOperator) return i;
    }
    if (!/\s/.test(c)) begun = true;
    i++;
  }
  return i;
}

/** Переменные выражения на [base, base+len) кода без прозы — с позициями. */
function* varsAt(code: string, base: number, len: number): Generator<{ name: string; at: number }> {
  const masked = code.slice(base, base + len);
  for (const id of masked.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const pos = id.index ?? 0;
    // Свойство — не переменная: `x.phone` судит поле ПД (`fieldRefs`), а `review.name` не псевдоним `name`.
    // Поле `this.x` — переменная x, как у корня выражения (седьмое ревью PR #3104).
    const before = masked.slice(Math.max(0, pos - 12), pos);
    if (/(?<!\.)\.\s*$/.test(before) && !/(?:^|[^\w$.])this\s*\??\.\s*$/.test(before)) continue;
    if (pos > 0 && /[\w$]/.test(masked[pos - 1])) continue;
    yield { name: id[0], at: base + pos };
  }
}

/**
 * Промпт-литерал ли это. Промпт: метка содержит `prompt`/`instruction`/`system`,
 * ЛИБО метка — ключ `content` (форма ChatMessage) в файле с зарубежным вызовом,
 * ЛИБО метка — сам зарубежный вызов (прямой аргумент-бэктик).
 */
function isPromptLiteral(label: string, hasForeignCaller: boolean): boolean {
  const l = label.toLowerCase();
  if (/prompt|instruction/.test(l)) return true;
  if ((FOREIGN_LLM_CALLERS as readonly string[]).includes(label)) return true;
  if ((l === 'content' || l === 'sys' || l === 'system') && hasForeignCaller) return true;
  return false;
}

/**
 * Слова, после которых `/` начинает регулярное выражение, а не деление. После
 * точки это имя свойства: `io.in / io.out` — деление.
 */
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/;

/**
 * Может ли это стоять сразу за регулярным выражением. Имя, строка, шаблон и `{`
 * за ним не бывают (кроме `as`, `satisfies`, `instanceof`, `in`) — значит,
 * первая `/` была делением, а «выражение» — кусок кода до следующей `/`.
 */
function regexFollows(src: string, at: number): boolean {
  let k = at;
  while (src[k] === ' ' || src[k] === '\t') k++;
  const c = src[k];
  if (c === undefined || c === '\n' || c === '\r') return true;
  if (/[\p{L}\p{N}_$]/u.test(c)) return /^(?:as|satisfies|instanceof|in)(?![\p{L}\p{N}_$])/u.test(src.slice(k, k + 12));
  return !'\'"`{'.includes(c);
}

/** Тело и флаги собираются в регулярное выражение (`/ b /total` — нет: таких флагов не бывает). */
function compiles(body: string, flags: string): boolean {
  try {
    new RegExp(body, flags);
    return true;
  } catch {
    return false;
  }
}

/**
 * Код без прозы: комментарии, содержимое строк, регулярные выражения и текст
 * бэктиков — пробелы; длина и переводы строк те же, `${…}` остаются кодом.
 *
 * Поток в промпт разбирается только по такому коду. Без маски `content:` в
 * комментарии или в тексте подсказки начинал отрезок, и разбор шёл по прозе:
 * первая проба на репозитории нашла «утечки» в комментариях самого стража.
 */
export function maskCode(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const afterWord = (j: number): boolean => REGEX_AFTER_WORD.test(out.slice(Math.max(0, j - 11), j + 1).join(''));
  const regexStart = (i: number): boolean => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const p = out[j];
    // `shown++ / total`, `left-- / 2` — постфикс кончает выражение: деление.
    if ((p === '+' || p === '-') && out[j - 1] === p) return false;
    // `count! / total` — ненулевое утверждение TypeScript, а не отрицание.
    if (p === '!' && j > 0) {
      const q = out[j - 1];
      if (q === ')' || q === ']') return false;
      if (/[\w$]/.test(q)) return afterWord(j - 1);
    }
    // `(line) => /```/.test(line)` — тело стрелки: выражение.
    if (p === '>' && out[j - 1] === '=') return true;
    // `)`, `]`, `}` и `<` (JSX `</div>`) — деление или разметка, не выражение.
    if ('(,=:[!&|?{;+-*%~^'.includes(p)) return true;
    if (/[\w$]/.test(p)) return afterWord(j);
    return false;
  };
  // Конец регулярного выражения с `/` на `open` или -1, если это не оно: тогда
  // `/` — деление, и текст за ней остаётся кодом. Без этой проверки ошибка в
  // выборе «деление или выражение» затирала код до следующей `/` строки —
  // вместе с открывающим бэктиком промпта (ревью #3104: `shown++ / total`).
  const regexEnd = (open: number): number => {
    let i = open + 1;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') return -1;
      if (c === '\\') { i += 2; continue; }
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      // `${` вне класса — подстановка шаблона, а не тело выражения.
      else if (c === '$' && src[i + 1] === '{') return -1;
      else if (c === '/') {
        const body = src.slice(open + 1, i);
        const flagsFrom = ++i;
        while (i < src.length && /[a-z]/i.test(src[i])) i++;
        return regexFollows(src, i) && compiles(body, src.slice(flagsFrom, i)) ? i : -1;
      }
      i++;
    }
    return -1;
  };
  // Код до конца файла или (внутри `${…}`) до парной `}`; возвращает её позицию.
  const code = (from: number, inTemplate: boolean): number => {
    let depth = 0;
    let i = from;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
      if (c === '"' || c === "'") {
        // Незакрытая до конца строки кавычка затирается вся, до переноса.
        const end = skipString(src, i);
        blank(i + 1, end - 1 > i && src[end - 1] === c ? end - 1 : end);
        i = end;
        continue;
      }
      if (c === '`') { i = template(i); continue; }
      if (c === '/' && regexStart(i)) { const end = regexEnd(i); if (end > 0) { blank(i, end); i = end; continue; } }
      if (inTemplate) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) return i; depth--; }
      }
      i++;
    }
    return i;
  };
  const template = (open: number): number => {
    let i = open + 1;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') return i + 1;
      if (c === '$' && src[i + 1] === '{') { i = code(i + 2, true) + 1; continue; }
      if (c !== '\n') out[i] = ' ';
      i++;
    }
    return i;
  };
  code(0, false);
  return out.join('');
}

/** Области видимости файла: имя в позиции → ключ «область:имя». */
interface Scopes {
  key(name: string, at: number): string;
  /** Тела функций файла по имени: от вызова `line(lead)` — к тому, что она возвращает. */
  functions: Map<string, FnBody[]>;
  /** Все тела функций, и безымянных: `return` вложенной функции — не свой. */
  bodies: FnBody[];
  /** Списки параметров функций и стрелок: имя там — объявление, а не значение. */
  params: Array<[number, number]>;
  /** Область тела для каждого списка `params` (по тому же номеру). */
  paramScopes: number[];
}
/** Тело функции: блок `{…}` или выражение-тело стрелки; параметры по позициям и область тела. */
interface FnBody { from: number; to: number; block: boolean; params: string[][]; scope: number }
interface Scope { from: number; to: number; parent: number; names: Set<string> }

const nameOfKey = (key: string): string => key.slice(key.indexOf(':') + 1);

/** Перед `(…) {` — заголовок цикла или условия, а не функции. */
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'with']);
/** `x => …` — стрелка с одним параметром без скобок. */
const ARROW_ONE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
const DECL_KEYWORD = /\b(?:const|let|var)\s+/g;

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Части через запятую на нулевой вложенности (`=>` в типах не закрывает скобку). */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '=' && text[i + 1] === '>') { i++; continue; }
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts;
}

/** Позиция скобки, парной открывающей на `open`. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ('([{'.includes(text[i])) depth++;
    else if (')]}'.includes(text[i]) && --depth === 0) return i;
  }
  return text.length;
}

/** Имена, которые связывает параметр или цель объявления (с деструктуризацией). */
function bindingNames(part: string, out: string[] = []): string[] {
  const p = part.trim().replace(/^\.\.\./, '').replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '');
  if (p.startsWith('{')) {
    for (const el of splitTop(p.slice(1, closeOf(p, 0)))) {
      const e = el.trim();
      if (!e) continue;
      if (e.startsWith('...')) { bindingNames(e, out); continue; }
      const colon = e.search(/:(?!:)/);
      const head = colon >= 0 ? e.slice(0, colon) : e;
      if (colon >= 0 && !/[=({[]/.test(head)) bindingNames(e.slice(colon + 1), out);
      else { const m = /^[A-Za-z_$][\w$]*/.exec(e); if (m) out.push(m[0]); }
    }
  } else if (p.startsWith('[')) {
    for (const el of splitTop(p.slice(1, closeOf(p, 0)))) if (el.trim()) bindingNames(el, out);
  } else {
    const m = /^[A-Za-z_$][\w$]*/.exec(p);
    if (m && m[0] !== 'this') out.push(m[0]);
  }
  return out;
}

/** Конец выражения-тела стрелки: `,`/`;`/непарная скобка на нулевой вложенности. */
function exprEnd(code: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') { i = templateParts(code, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if ((c === ',' || c === ';') && depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * После `(…):` — тип результата: где за ним `=>` (стрелка) или `{` тела
 * функции; null — это не функция (тернарный `? (x) : y`, `case (x):`).
 * Скобка `{` сразу после `:`, `|`, `&` — литерал типа, а не тело.
 */
function afterReturnType(code: string, from: number): { at: number; arrow: boolean } | null {
  let depth = 0;
  const end = Math.min(code.length, from + 400);
  for (let i = from; i < end; i++) {
    const c = code[i];
    if (c === '=' && code[i + 1] === '>') { if (depth === 0) return { at: i + 2, arrow: true }; i++; continue; }
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') { if (depth === 0) return null; depth--; }
    else if (c === '{') {
      if (depth === 0) {
        let j = i - 1;
        while (j >= from && /\s/.test(code[j])) j--;
        if (j >= from && /[\w$>\])}'"]/.test(code[j])) return { at: i, arrow: false };
      }
      depth++;
    } else if (c === '}') { if (depth === 0) return null; depth--; }
    else if ((c === ';' || c === ',' || c === '=') && depth === 0) return null;
  }
  return null;
}

/** `(` открывает параметры функции или метода (`name(…)`, `function (…)`, `catch (e)`), а не условие. */
function isFunctionHead(code: string, open: number): boolean {
  let j = open - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] === '>') {
    // Обобщённый метод: `name<T>(…)`.
    let d = 0;
    for (; j >= 0; j--) {
      if (code[j] === '>') d++;
      else if (code[j] === '<' && --d === 0) { j--; break; }
    }
    while (j >= 0 && /\s/.test(code[j])) j--;
  }
  const word = identBefore(code, j + 1);
  return word !== '' && !CONTROL_WORDS.has(word);
}

/**
 * Имя функции по тексту перед `(` её параметров: `function line(`, метод
 * `describe(`, `const line = (`, `line = async (`, `const f = function (`.
 * Безымянный колбэк (`map((l) =>`) — пустая строка.
 */
function functionName(code: string, open: number): string {
  const before = code.slice(Math.max(0, open - 160), open);
  const own = /(?:^|[^\w$.])(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(before)?.[1] ?? '';
  if (own && !CONTROL_WORDS.has(own) && !NOT_ROOT.has(own) && own !== 'catch') return own;
  const assigned = /([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s*)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*)?(?:<[^()]*>\s*)?$/.exec(before);
  return assigned?.[1] ?? '';
}

/**
 * Области видимости: каждый блок `{…}` и выражение-тело стрелки. Объявления
 * (`const`/`let`/`var`, с деструктуризацией) — в самую внутреннюю область,
 * параметры функций и стрелок — в их тело. Имя в позиции принадлежит
 * ближайшей объемлющей области, где оно объявлено; не объявленное в файле
 * (импорт, `this.x`) — общее на файл.
 */
function buildScopes(code: string): Scopes {
  const len = code.length;
  const scopes: Scope[] = [{ from: 0, to: len + 1, parent: -1, names: new Set() }];
  const blockAt = new Map<number, number>();
  const parens: Array<[number, number]> = [];
  const stack: Array<{ ch: string; at: number }> = [];
  for (let i = 0; i < len; i++) {
    const c = code[i];
    if (c === '(' || c === '{' || c === '[') { stack.push({ ch: c, at: i }); continue; }
    if (c !== ')' && c !== '}' && c !== ']') continue;
    const want = c === ')' ? '(' : c === '}' ? '{' : '[';
    let k = stack.length - 1;
    while (k >= 0 && stack[k].ch !== want) k--;
    if (k < 0) continue;
    const open = stack[k].at;
    stack.length = k;
    if (c === ')') parens.push([open, i]);
    else if (c === '}') { blockAt.set(open, scopes.length); scopes.push({ from: open, to: i + 1, parent: -1, names: new Set() }); }
  }

  const bodyAt = (pos: number): number => {
    const p = skipWs(code, pos);
    const block = blockAt.get(p);
    if (block !== undefined) return block;
    scopes.push({ from: p, to: exprEnd(code, p), parent: -1, names: new Set() });
    return scopes.length - 1;
  };
  const bind = (scope: number, names: string[]) => { for (const n of names) scopes[scope].names.add(n); };
  const functions = new Map<string, FnBody[]>();
  const bodies: FnBody[] = [];
  const paramLists: Array<[number, number]> = [];
  const paramScopes: number[] = [];
  const fn = (name: string, scope: number, params: string[][]) => {
    const s = scopes[scope];
    const body: FnBody = { from: s.from, to: s.to, block: code[s.from] === '{' && blockAt.get(s.from) === scope, params, scope };
    bodies.push(body);
    if (name) functions.set(name, [...(functions.get(name) ?? []), body]);
  };

  for (const [open, close] of parens) {
    const k = skipWs(code, close + 1);
    let body = -1;
    if (code.startsWith('=>', k)) body = bodyAt(k + 2);
    else if (code[k] === ':') {
      const t = afterReturnType(code, k + 1);
      if (t?.arrow) body = bodyAt(t.at);
      else if (t) body = blockAt.get(t.at) ?? -1;
    } else if (code[k] === '{' && isFunctionHead(code, open)) body = blockAt.get(k) ?? -1;
    if (body < 0) continue;
    const params = splitTop(code.slice(open + 1, close)).map((part) => bindingNames(part));
    paramLists.push([open, close]);
    paramScopes.push(body);
    for (const names of params) bind(body, names);
    fn(functionName(code, open), body, params);
  }
  ARROW_ONE.lastIndex = 0;
  for (let m = ARROW_ONE.exec(code); m; m = ARROW_ONE.exec(code)) {
    if (NOT_ROOT.has(m[1])) continue;
    const body = bodyAt(m.index + m[0].length);
    paramLists.push([m.index - 1, m.index + m[1].length]);
    paramScopes.push(body);
    bind(body, [m[1]]);
    fn(functionName(code, m.index), body, [[m[1]]]);
  }

  // Вложенность: снаружи внутрь, внутренняя область перекрашивает внешнюю.
  const order = scopes.map((_, id) => id).sort((a, b) => scopes[a].from - scopes[b].from || scopes[b].to - scopes[a].to);
  const inner = new Int32Array(len + 1);
  const open: number[] = [];
  for (const id of order) {
    const s = scopes[id];
    while (open.length && scopes[open[open.length - 1]].to <= s.from) open.pop();
    s.parent = open.length ? open[open.length - 1] : -1;
    open.push(id);
    inner.fill(id, s.from, Math.min(len + 1, s.to));
  }

  DECL_KEYWORD.lastIndex = 0;
  for (let m = DECL_KEYWORD.exec(code); m; m = DECL_KEYWORD.exec(code)) {
    const at = m.index + m[0].length;
    const target = code[at] === '{' || code[at] === '[' ? code.slice(at, closeOf(code, at) + 1) : code.slice(at, at + 80);
    bind(inner[m.index], bindingNames(target));
  }

  return {
    key(name: string, at: number): string {
      for (let s = inner[Math.max(0, Math.min(len, at))]; s >= 0; s = scopes[s].parent) {
        if (scopes[s].names.has(name)) return `${s}:${name}`;
      }
      return `-1:${name}`;
    },
    functions,
    bodies,
    params: paramLists,
    paramScopes,
  };
}

/**
 * Присваивание: `const x = …`, `x = …`, `x += …`, поле `this.x = …` и
 * `box.lines = …` (не `==`, `=>`, `<=`, `>=`, `!=`). Поле — тот же ключ, что у
 * корня `this.x` и получателя `box.lines.join(…)`: ребро «собрал в поле, отдал
 * в content:» (четвёртое ревью PR #3104).
 */
const ASSIGN_HEAD = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?\+?=(?![=>])/g;

/** Аннотация типа не закрывает чужих скобок и закрывает свои: `: { a: string }`, но не `: Lead) {`. */
function balancedType(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if ((ch === ')' || ch === ']' || ch === '}') && --depth < 0) return false;
  }
  return depth === 0;
}
/** Ключ стока: `content:`/`system:`, у агента SDK — `systemPrompt:`/`userMessage:`; значение уходит модели. */
const SINK_KEY_HEAD = /\b(content|system|systemPrompt|userMessage)\s*:/g;
/** Зарубежный вызов: `callAIFast(…)`, `runSDKAgent(…)` и т. п. */
const FOREIGN_CALL_HEAD = new RegExp(`\\b(${FOREIGN_DOORS.join('|')})\\s*\\(`, 'g');
/** Слова языка — не имена переменных. */
const NOT_ROOT = new Set([
  'this', 'await', 'new', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'return', 'async', 'function',
  'const', 'let', 'var', 'if', 'else', 'as', 'satisfies', 'true', 'false', 'null', 'undefined', 'yield',
  // Типы TypeScript в аннотациях — не переменные (`rows: string[]`, `pool.query<{ title: string }>`).
  'string', 'number', 'boolean', 'unknown', 'any', 'never', 'object', 'bigint', 'symbol',
]);
/** Перед `(` — вызов, а не группировка; ключевое слово перед `(` — группировка. */
const CALL_BEFORE = /[\w$)\]]$/;
const KEYWORD_BEFORE = /(?:^|[^\w$])(?:if|for|while|switch|catch|return|typeof|await|new|in|of|yield|void|delete)$/;

/** Конец бэктик-литерала, начатого на `open`, и его `${…}` — отрезками исходника. */
function templateParts(text: string, open: number): { end: number; exprs: Array<{ from: number; to: number }> } {
  const exprs: Array<{ from: number; to: number }> = [];
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return { end: i + 1, exprs };
    if (ch === '$' && text[i + 1] === '{') {
      const from = i + 2;
      i = from;
      let depth = 1;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '{') { depth++; i++; }
        else if (c === '}') { depth--; i++; }
        else if (c === '`') i = templateParts(text, i).end;
        else if (c === '"' || c === "'") i = skipString(text, i);
        else i++;
      }
      exprs.push({ from, to: Math.max(from, i - 1) });
      continue;
    }
    i++;
  }
  return { end: i, exprs };
}

/** Последние значимые символы перед `end` (не дальше `from`). */
function tailBefore(code: string, from: number, end: number): string {
  let b = end;
  while (b > from && /\s/.test(code[b - 1])) b--;
  return code.slice(Math.max(from, b - 80), b);
}

/** Первые значимые символы после `from` (не дальше `to`). */
function headAfter(code: string, from: number, to: number): string {
  const a = Math.min(skipWs(code, from), to);
  return code.slice(a, Math.min(to, a + 80));
}

interface Root { name: string; at: number }

/**
 * Корни выражения на отрезке кода — имена переменных, из которых собран его
 * текст, с позициями (по ним — область видимости).
 * - имя свойства после точки — не корень, кроме `this.x` (это x);
 * - имя вызываемой функции — не корень; получатель метода — корень:
 *   `ctx.filter(Boolean).join('\n')`, `this.ctx.join('\n')` → ctx; у
 *   `box.lines.join(…)` корень — box (`push` в `box.lines` — ребро и в box);
 * - аргументы вызова — тоже корни: что вызов делает с текстом, страж не
 *   знает (`Object.values(parts).join(…)`, `format(ctx)`). Внутри redactPII —
 *   нет: там ПД уже нет. Прежняя узость («аргументы — только у стока») на
 *   первой пробе берегла от SQL и fetch; с маской кода, областями видимости и
 *   находкой только по полю ПД она ложных находок по репозиторию не даёт, а
 *   пропускала целый класс записи (ревью PR #3104);
 * - ключ объектного литерала — не корень; `${…}` в бэктиках — выражения.
 */
function rootsAt(
  code: string, from: number, to: number, cutters: ReadonlySet<string>, out: Root[] = [], sanitized = false,
  opaque: ReadonlySet<string> = NO_SANITIZERS,
): Root[] {
  // Кадры скобок: вызов ли, и не redactPII ли он (или функция файла, если её
  // аргументы считаются параметрами, — для рода ПД).
  const frames: boolean[] = [];
  const inSafe = () => sanitized || frames.includes(true);
  let i = from;
  while (i < to) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') {
      const t = templateParts(code, i);
      for (const e of t.exprs) rootsAt(code, e.from, e.to, cutters, out, inSafe(), opaque);
      i = t.end;
      continue;
    }
    if (/[0-9]/.test(c)) { while (i < to && /[\w$.]/.test(code[i])) i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < to && /[\w$]/.test(code[j])) j++;
      const name = code.slice(i, j);
      const before = tailBefore(code, from, i);
      const after = headAfter(code, j, to);
      // Одна точка (не `...x`) — свойство; `this.x` — само имя x.
      const isProp = /(?<!\.)\.$/.test(before);
      const viaThis = isProp && /(?:^|[^\w$.])this\s*\??\.$/.test(before);
      const isCallee = after.startsWith('(') || after.startsWith('?.(');
      // Ключ объекта или члена литерала типа (`{ id: number; operator_inn: string }`).
      const isKey = after.startsWith(':') && !after.startsWith('::') && /(?:^|[{,;])$/.test(before);
      if (!NOT_ROOT.has(name) && !isCallee && !isKey && (!isProp || viaThis) && !inSafe()) {
        out.push({ name, at: i });
      }
      i = j;
      continue;
    }
    if (c === '(') {
      const before = tailBefore(code, from, i);
      const call = CALL_BEFORE.test(before) && !KEYWORD_BEFORE.test(before);
      const callee = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1] ?? '';
      frames.push(call && (cutters.has(callee) || opaque.has(callee)));
      i++;
      continue;
    }
    if (c === '[' || c === '{') { frames.push(false); i++; continue; }
    if (c === ')' || c === ']' || c === '}') { frames.pop(); i++; continue; }
    i++;
  }
  return out;
}

/** Значение после `ключ:` — до `,`/закрывающей скобки на нулевой вложенности; строки и бэктики целиком. */
function valueAfter(src: string, from: number): string {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i); continue; }
    if (c === '`') { i = templateParts(src, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === ';') && depth === 0) break;
    i++;
  }
  return src.slice(from, i);
}

/** Аргументы вызова: от `(` на `open` до парной `)`; строки и бэктики целиком. */
function argsAfter(src: string, open: number): string {
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i); continue; }
    if (c === '`') { i = templateParts(src, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    i++;
  }
  return src.slice(open + 1, Math.max(open + 1, i - 1));
}

/** `X.push(…)`, `X.unshift(…)`, `X.add(…)`, `X.concat(…)`, `X.set(k, v)` — X получает текст аргументов. */
const PUSH_CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|add|concat|set)\s*\(/g;

/** Отрезок кода, текст которого доходит до модели. */
interface FlowSpan { from: number; to: number }

/** Вызов по имени: `name(` или `this.name(` (не `obj.name(`). */
const CALL_SITE = /(?<![\w$.])(?:this\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/** Аргументы вызова отрезками: от `(` на `open` до парной `)`, по запятым нулевой вложенности. */
function argSpans(code: string, open: number): FlowSpan[] {
  const spans: FlowSpan[] = [];
  let depth = 0;
  let from = open + 1;
  let i = open + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') { i = templateParts(code, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { if (i > from || spans.length) spans.push({ from, to: i }); return spans; }
      depth--;
    } else if (c === ',' && depth === 0) { spans.push({ from, to: i }); from = i + 1; }
    i++;
  }
  return spans;
}

/**
 * Литералы отрезка и вызовы функций в нём.
 *
 * Литерал — где бы ни стоял: элемент `[…]`, колбэк `map` или `reduce`,
 * аргумент любого вызова. Что вызов делает с текстом, страж не знает, и
 * перечень «несущих» вызовов (был `map`/`flatMap`) обходился следующим же
 * (`reduce`, третье ревью PR #3104) — поэтому проверяется всякий литерал, кроме
 * литерала внутри redactPII. Узость держит сама находка: только однозначное
 * поле ПД, имя-контакт или псевдоним в `${…}`.
 *
 * Вызов `name(…)` или `this.name(…)` — кандидат в функцию файла: её результат
 * часть отрезка (`content: line(lead)`, то же ревью).
 */
function literalsIn(
  code: string, span: FlowSpan, cutters: ReadonlySet<string>, opaque: ReadonlySet<string> = NO_SANITIZERS,
): { literals: number[]; callees: string[] } {
  const frames: Array<{ call: boolean; callee: string }> = [];
  const literals: number[] = [];
  const callees: string[] = [];
  const passes = () => frames.every((f) => !f.call || (!cutters.has(f.callee) && !opaque.has(f.callee)));
  let i = span.from;
  while (i < span.to) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') { if (passes()) literals.push(i); i = templateParts(code, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') {
      const before = tailBefore(code, span.from, i);
      const call = c === '(' && CALL_BEFORE.test(before) && !KEYWORD_BEFORE.test(before);
      const callee = call ? (/([A-Za-z_$][\w$]*)$/.exec(before)?.[1] ?? '') : '';
      // Кандидат в функцию файла — и `svc.method(`: по имени её найдёт returnsOf.
      if (callee && passes() && !cutters.has(callee)) callees.push(callee);
      frames.push({ call, callee });
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') { frames.pop(); i++; continue; }
    i++;
  }
  return { literals, callees };
}

/** Что функция возвращает: выражение-тело стрелки или выражения её `return` (не вложенных функций). */
function returnSpans(code: string, body: FnBody, all: FnBody[]): FlowSpan[] {
  if (!body.block) return [{ from: body.from, to: body.to }];
  const nested = all.filter((b) => b !== body && b.from > body.from && b.to <= body.to);
  const spans: FlowSpan[] = [];
  const re = /\breturn\b/g;
  re.lastIndex = body.from;
  for (let m = re.exec(code); m && m.index < body.to; m = re.exec(code)) {
    const at = m.index;
    if (nested.some((b) => at > b.from && at < b.to)) continue;
    const from = at + m[0].length;
    spans.push({ from, to: stmtEnd(code, from) });
  }
  return spans;
}

/** Поток в промпт: переменные (ключи областей) и литералы (по началу), доходящие до модели. */
interface PromptFlow { reach: Set<string>; literalStarts: Set<number> }

/**
 * Что в файле доходит до зарубежной модели: неподвижная точка.
 *
 * Дыра, найденная ревьюером deepseek-flash в пробе 07.11 (run 2, откат #2506):
 *
 *     if (tourist_phone) ctx.push(`Тел: ${sanitizePromptInput(tourist_phone).text}`);
 *     if (ctx.length) systemContent += `\n\nСОБЕСЕДНИК:\n${ctx.join('\n')}`;
 *     return [{ role: 'system', content: systemContent }, …];
 *
 * Ни один литерал не был «промптом» по метке (`push`, `+=` без имени), и страж
 * молчал. Два ревью PR #3104 (тот же ревьюер) нашли, где следующие редакции
 * рвали цепочку: цепочка методов и `this.ctx`, промежуточная переменная,
 * значение стока не голым именем; `lines.push(line)`, литерал в колбэке
 * `map`, элемент литерала массива, `unshift`/`add`, получатель-свойство
 * `box.lines`; литерал в колбэке `reduce`, строка из функции-помощника. Это
 * один класс, и закрыт он не узорами, а отрезками кода:
 * - начало — значения `content:`/`system:` и аргументы зарубежного вызова
 *   (вместе с аргументами вложенных вызовов: `withContext(x)` несёт x),
 *   `${…}` промптов по метке и присваивания имени с prompt/instruction;
 * - переменная в потоке — её правая часть (с аргументами вызовов: что вызов
 *   делает с текстом, страж не знает; кроме redactPII) и аргументы
 *   `push`/`unshift`/`add`/`concat` в неё; литералы, записанные в неё;
 * - из каждого такого отрезка — корни (`rootsAt`), литералы внутри него, где
 *   бы ни стояли (`[…]`, колбэк `map`/`reduce`, аргумент любого вызова), и
 *   то, что возвращают вызванные в нём функции файла (`content: line(lead)`).
 *   `redactPII(…)` — конец ПД.
 * Отрезки берутся из кода без прозы (`maskCode`), переменные — по областям
 * видимости (`buildScopes`): `text` из вопроса туриста и `text` уведомления
 * оператору в соседней функции — разные переменные.
 * Сток `content:`/`system:` и вызов — только в файле с зарубежным вызовом (то
 * же условие, что у метки `content`); переменная `*prompt*` — промпт везде, как
 * и литерал с такой меткой: `const prompt = [\`Тел: ${lead.phone}\`].join('\n')`.
 */
function promptFlow(
  raw: string, sc: Scopes, literals: TemplateLiteral[], hasForeign: boolean,
  edges: readonly Edge[], seeds: readonly Seed[], cutters: ReadonlySet<string>,
): PromptFlow {
  // Параметры SQL-запроса — не текст и для потока (как и для рода ПД): ключ
  // `kuzmich_mem_${chatId}` в `pool.query(sql, [key])` до модели не доходит.
  const code = blankAll(raw, queryParamRanges(raw));
  const reach = new Set<string>();
  const literalStarts = new Set<number>();
  const byStart = new Map(literals.map((l) => [l.start, l] as const));
  const add = (roots: Root[]): boolean => {
    let grew = false;
    for (const r of roots) {
      const k = sc.key(r.name, r.at);
      if (!reach.has(k)) { reach.add(k); grew = true; }
    }
    return grew;
  };
  const returns = new Map<string, FlowSpan[]>();
  const returnsOf = (name: string): FlowSpan[] => {
    let spans = returns.get(name);
    if (!spans) {
      spans = (sc.functions.get(name) ?? []).flatMap((b) => returnSpans(code, b, sc.bodies));
      returns.set(name, spans);
    }
    return spans;
  };
  // Литерал в потоке: его `${…}` — тоже отрезки потока (корни, вложенные
  // литералы, вызовы функций файла: `${line(lead)}`).
  const literalIn = (at: number): boolean => {
    if (literalStarts.has(at)) return false;
    literalStarts.add(at);
    const lit = byStart.get(at);
    if (!lit) return false;
    let grew = false;
    for (const { expr, at: off } of literalInterpolations(lit, code)) {
      const from = at + 1 + off + 2;
      if (take({ from, to: from + expr.length })) grew = true;
    }
    return grew;
  };
  const taken = new Set<string>();
  const take = (span: FlowSpan): boolean => {
    const id = `${span.from}:${span.to}`;
    if (taken.has(id)) return false;
    taken.add(id);
    const roots = rootsAt(code, span.from, span.to, cutters);
    let grew = add(roots);
    const inner = literalsIn(code, span, cutters);
    for (const at of inner.literals) if (literalIn(at)) grew = true;
    // Вызов функции файла и она же по ссылке (`leads.map(line)`) — её возврат в потоке.
    const fns = new Set([...inner.callees, ...roots.filter((r) => sc.functions.has(r.name)).map((r) => r.name)]);
    for (const name of fns) for (const r of returnsOf(name)) if (take(r)) grew = true;
    return grew;
  };

  // Стоки — значения и аргументы дверей; переменная `*prompt*` — сама в потоке.
  for (const seed of seeds) {
    if (seed.key) reach.add(seed.key);
    else take(seed.span);
  }
  for (const lit of literals) {
    if (isPromptLiteral(lit.label, hasForeign)) literalIn(lit.start);
  }

  // Цепочки в коде короткие; предел — от патологии.
  for (let pass = 0; pass < 12; pass++) {
    let grew = false;
    for (const e of edges) if (reach.has(e.key) && take(e.span)) grew = true;
    for (const lit of literals) {
      const into = (lit.label !== '' && reach.has(sc.key(lit.label, lit.start)))
        || (lit.receiver !== undefined && reach.has(sc.key(lit.receiver, lit.start)));
      if (into && literalIn(lit.start)) grew = true;
    }
    if (!grew) break;
  }
  return { reach, literalStarts };
}

/** Разбор файла: маска, области видимости, рёбра, стоки и род ПД — общие для потока и находок. */
interface FileView {
  src: string;
  code: string;
  sc: Scopes;
  literals: TemplateLiteral[];
  hasForeign: boolean;
  edges: Edge[];
  seeds: Seed[];
  taints: Taints;
}

/**
 * Доступ к полю скобками с ключом-строкой — то же поле (тринадцатое ревью PR
 * #3104): `lead['phone']` читается как `lead.phone`, `x?.["email"]` — как
 * `x?.email`. Длина текста сохраняется (хвост — пробелы), и позиции находок
 * не сдвигаются. Ключ из переменной (`lead[f]`) так не прочитать — это
 * названное ограничение.
 */
export function bracketsToDots(src: string): string {
  return src.replace(/(?<=[\w$)\]])(\?\.)?\[\s*(['"])([A-Za-z_$][\w$]*)\2\s*\]/g, (m: string, opt: string | undefined, _q: string, key: string) => {
    const head = `${opt ?? ''}${opt ? '' : '.'}${key}`;
    return head + ' '.repeat(m.length - head.length);
  });
}

function viewOf(raw: string): FileView {
  const src = bracketsToDots(raw);
  const code = maskCode(src);
  const sc = buildScopes(code);
  const hasForeign = fileTalksAbroad(src);
  const links: Link[] = [];
  const edges = buildEdges(code, sc, links);
  const seeds = seedsOf(code, edges, hasForeign);
  return {
    src, code, sc, hasForeign, edges, seeds,
    literals: extractTemplateLiterals(src, code),
    taints: taintsIn(code, sc, edges, seeds, links, src),
  };
}

/** Имена переменных, текст которых доходит до модели, — для теста и разбора находки. */
export function promptFlowOf(src: string): { reach: string[] } {
  const v = viewOf(src);
  const f = promptFlow(v.code, v.sc, v.literals, v.hasForeign, v.edges, v.seeds, CONTACT_SANITIZERS);
  return { reach: [...new Set([...f.reach].map(nameOfKey))].sort() };
}

/**
 * Телефон службы, а не человека: МЧС у маршрута (kamchatka_routes.mchs_phone,
 * CLAUDE.md §10) — публичный номер для консультации. Персональными данными не
 * является, и находкой его интерполяция не будет.
 */
const SERVICE_CONTACT = /\.\s*mchs_phone\b/gi;

/**
 * Переменная, названная контактом (`tourist_phone`, `email`, `contacts`), —
 * контакт, как и поле с тем же именем. Нужна, когда переменная пришла
 * параметром: псевдоним по объявлению видит `const { tourist_phone } =
 * parsed.data` в обработчике, но не параметр `tourist_phone` сборщика
 * подсказки, куда его передали (форма отката #2506).
 */
const REDACTABLE_NAMED = new RegExp(`^(?:[a-z0-9$]+_)*(?:${REDACTABLE_WORD})s?$`, 'i');
const IDENT_NAMED = new RegExp(`^(?:[a-z0-9$]+_)*(?:${IDENT_WORD})s?$`, 'i');

/**
 * Отрезки аргументов вызовов функций файла внутри [from, to) — `line(…)`,
 * `this.line(…)` и `svc.line(…)`: для рода ПД они параметры, а не текст, и
 * идут в функцию ребром (`buildEdges`).
 */
function ownCallArgRanges(code: string, from: number, to: number, own: ReadonlySet<string>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (own.size === 0) return out;
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  re.lastIndex = from;
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    if (!own.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    out.push([open, open + 1 + argsAfter(code, open).length]);
  }
  return out;
}

/** Род ПД переменной в `${…}` — или функции файла, если это её вызов (`${line(lead)}`). */
function carried(code: string, v: Root, t: Taints, sc: Scopes, kind: Kind, limit: number): boolean {
  if (code[skipWs(code, v.at + v.name.length)] === '(') return t.fns.get(v.name)?.has(kind) ?? false;
  const key = carrierKey(code, v, sc, limit);
  return key !== null && (t.vars.get(key)?.has(kind) ?? false);
}

/** Контакт в `${…}` на [base, base+len): поле, переменная с именем контакта или с родом контакта — вне аргументов redactPII. */
function contactIn(code: string, base: number, len: number, t: Taints, sc: Scopes): boolean {
  const clean = sanitizedRanges(code, base, base + len, CONTACT_SANITIZERS);
  // Поле ПД — обращение в коде, а не текст строки: адрес API Telegram в
  // строке (`…//api.telegram…`) полем `.telegram` не является.
  const visible = blankRanges(code.slice(base, base + len), base, clean).replace(SERVICE_CONTACT, (m) => ' '.repeat(m.length));
  if (fieldRefs(visible, isRedactableId).length > 0) return true;
  for (const v of varsAt(code, base, len)) {
    if (insideAny(v.at, clean)) continue;
    if (isRedactableId(v.name) && wholeUse(code, v, base + len)) return true;
    if (carried(code, v, t, sc, 'contact', base + len)) return true;
  }
  return false;
}

/** Адрес, документ, мессенджер в `${…}`: поле, имя или род — redactPII их не убирает. */
function identIn(code: string, base: number, len: number, t: Taints, sc: Scopes): boolean {
  if (fieldRefs(code.slice(base, base + len), isIdentId).length > 0) return true;
  for (const v of varsAt(code, base, len)) {
    if (isIdentId(v.name) && wholeUse(code, v, base + len)) return true;
    if (carried(code, v, t, sc, 'ident', base + len)) return true;
  }
  return false;
}

/** Имя человека в `${…}`: поле или род имени — redactPII его не убирает. */
function nameIn(code: string, base: number, len: number, t: Taints, sc: Scopes): boolean {
  const exprCode = code.slice(base, base + len);
  if (identRefs(exprCode, isPersonNameId).length > 0 || PERSONAL_OWNER_NAME.test(exprCode)) return true;
  for (const v of varsAt(code, base, len)) if (carried(code, v, t, sc, 'name', base + len)) return true;
  return false;
}

const PERSONAL_OWNER_NAME_ALL = new RegExp(PERSONAL_OWNER_NAME.source, 'gi');

/**
 * Находки в самом стоке, вне шаблонов: поле ПД, переменная с именем контакта,
 * переменная или функция файла с родом ПД, пришедшим не через шаблон.
 *
 * Седьмое ревью PR #3104: находка рождалась только в `${…}` шаблона, и
 * `content: lead.email`, `'Клиент: ' + lead.phone`, `[lead.name,
 * lead.phone].join(', ')` проходили молча, хотя сток был найден. Шаблоны
 * по-прежнему судятся в своих `${…}`; вложенный сток (`content:` внутри
 * аргумента двери) — сам, по своему месту; аргументы функции файла — её
 * параметры, и их род виден там, где они уходят модели.
 */
function sinkFindings(file: string, v: FileView): PIIFinding[] {
  const out: PIIFinding[] = [];
  if (v.seeds.length === 0) return out;
  const { src, code, sc, taints } = v;
  const own: ReadonlySet<string> = new Set(sc.functions.keys());
  const codeT = blankAll(blankAll(code, queryParamRanges(code)), templateRanges(code));
  const seen = new Set<string>();
  const lineOf = (at: number) => src.slice(0, at).split('\n').length;
  const report = (at: number, expr: string, kind: PIIFinding['kind'], context: string) => {
    const id = `${kind}:${at}:${expr}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ file, line: lineOf(at), expr, kind, context });
  };
  /** `lead.phone` по совпадению `.phone`: имя перед точкой — для текста находки. */
  const member = (at: number, match: string) => {
    const dot = match.indexOf('.');
    const head = dot >= 0 ? identBefore(code, skipBack(code, at)) : '';
    return (head ? `${head}` : '') + match.replace(/\s+/g, '');
  };
  for (const seed of v.seeds) {
    const { from, to } = seed.span;
    const nested = v.seeds
      .filter((o) => o !== seed && o.span.from >= from && o.span.to <= to && (o.span.from > from || o.span.to < to))
      .map((o) => [o.span.from, o.span.to] as const);
    const text = blankAll(codeT, nested);
    const opaque = ownCallArgRanges(text, from, to, own);

    const clean = [...sanitizedRanges(text, from, to, CONTACT_SANITIZERS), ...opaque];
    const visible = blankRanges(text.slice(from, to), from, clean).replace(SERVICE_CONTACT, (m) => ' '.repeat(m.length));
    for (const m of fieldRefs(visible, isRedactableId)) report(from + m.index, member(from + m.index, m.text), 'contact', seed.context);
    /** Текст находки: имя или поле (`o.body`). */
    const shown = (r: Root) => { const f = carrierOf(text, r.at + r.name.length, to, sc.functions)?.field; return f ? `${r.name}.${f}` : r.name; };
    for (const r of rootsAt(text, from, to, CONTACT_SANITIZERS, [], false, own)) {
      if (insideAny(r.at, sc.params)) continue;
      const named = isRedactableId(r.name) && wholeUse(text, r, to);
      const key = carrierKey(text, r, sc, to);
      if (named || (key !== null && taints.vars.get(key)?.has('contact'))) report(r.at, shown(r), 'contact', seed.context);
    }
    for (const c of literalsIn(text, seed.span, CONTACT_SANITIZERS, own).callees) {
      if (own.has(c) && taints.fns.get(c)?.has('contact')) report(from, `${c}()`, 'contact', seed.context);
    }

    const plain = blankRanges(text.slice(from, to), from, opaque);
    // Адрес, документ, мессенджер — чистка redactPII их не гасит.
    for (const m of fieldRefs(plain, isIdentId)) report(from + m.index, member(from + m.index, m.text), 'contact', seed.context);
    for (const m of identRefs(plain, isPersonNameId)) report(from + m.index, m.text, 'name', seed.context);
    for (const m of plain.matchAll(PERSONAL_OWNER_NAME_ALL)) report(from + (m.index ?? 0), m[0].replace(/\s+/g, ''), 'name', seed.context);
    for (const r of rootsAt(text, from, to, NO_SANITIZERS, [], false, own)) {
      if (insideAny(r.at, sc.params)) continue;
      const key = carrierKey(text, r, sc, to);
      if (key !== null && taints.vars.get(key)?.has('name')) report(r.at, shown(r), 'name', seed.context);
      const identNamed = isIdentId(r.name) && wholeUse(text, r, to);
      if (identNamed || (key !== null && taints.vars.get(key)?.has('ident'))) report(r.at, shown(r), 'contact', seed.context);
    }
    for (const c of literalsIn(text, seed.span, NO_SANITIZERS, own).callees) {
      if (own.has(c) && taints.fns.get(c)?.has('name')) report(from, `${c}()`, 'name', seed.context);
      if (own.has(c) && taints.fns.get(c)?.has('ident')) report(from, `${c}()`, 'contact', seed.context);
    }
  }
  return out;
}

/** Позиция конца значимого текста перед `at` (пробелы пропущены). */
function skipBack(code: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(code[i - 1])) i--;
  return i;
}

/**
 * Сканирует ОДИН исходник. Чистая функция — принимает путь и содержимое.
 *
 * Поток считается дважды: для контактов redactPII его обрывает, для имён — нет
 * (redactPII имён не чистит). Литерал, дошедший до модели только сквозь
 * redactPII, проверяется на имя, но не на телефон.
 */
export function scanSource(file: string, src: string): PIIFinding[] {
  const findings: PIIFinding[] = [];
  // Без зарубежной модели, промпта по метке и переменной `*prompt*` — смотреть нечего.
  if (!fileTalksAbroad(src) && !PROMPT_NAME.test(src)) return findings;
  const v = viewOf(src);
  const { code, sc, literals, hasForeign, taints } = v;
  const flowContact = promptFlow(code, sc, literals, hasForeign, v.edges, v.seeds, CONTACT_SANITIZERS);
  const flowName = promptFlow(code, sc, literals, hasForeign, v.edges, v.seeds, NO_SANITIZERS);
  const reached = (f: PromptFlow, lit: TemplateLiteral): boolean => f.literalStarts.has(lit.start)
    || (lit.label !== '' && f.reach.has(sc.key(lit.label, lit.start)))
    || (lit.receiver !== undefined && f.reach.has(sc.key(lit.receiver, lit.start)));

  for (const lit of literals) {
    const labeled = isPromptLiteral(lit.label, hasForeign);
    const forContact = labeled || reached(flowContact, lit);
    const forName = labeled || reached(flowName, lit);
    if (!forContact && !forName) continue;

    for (const { expr, at } of literalInterpolations(lit, code)) {
      const base = lit.start + 1 + at + 2;
      const kind: PIIFinding['kind'] | null = forContact && contactIn(code, base, expr.length, taints, sc) ? 'contact'
        : forName && identIn(code, base, expr.length, taints, sc) ? 'contact'
          : forName && nameIn(code, base, expr.length, taints, sc) ? 'name' : null;
      if (!kind) continue;

      // Номер строки: смещение открытия литерала + смещение интерполяции в теле.
      const absOffset = lit.start + 1 + at;
      const line = src.slice(0, absOffset).split('\n').length;
      const context = lit.receiver ? `${lit.receiver}.${lit.label}` : lit.label || 'выражение';
      findings.push({ file, line, expr: expr.trim(), kind, context });
    }
  }
  findings.push(...sinkFindings(file, v));
  return findings;
}
