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
 * переменной `*prompt*`, значение `content:`, аргумент вызова зарубежной
 * модели — и то, что течёт в них через переменные, массивы, склейки и
 * функции внутри файла, `promptFlow`) и ловит в нём интерполяцию однозначных ПД-полей
 * (`.phone`, `.email`, персональные `*_name`/`lead.name`), переменных с именем
 * контакта и их псевдонимов без чистки. Поток между файлами (сборщик в одном,
 * вызов в другом) он не видит — это добивает ревью.
 *
 * Философия репо (CLAUDE.md §8): лучше узкий детерминированный guard с
 * allowlist, чем абзацы в промпте агента. Ложные срабатывания дороги (блокируют
 * CI), поэтому правило точечное: телефон/почта не двусмысленны (у места их нет),
 * имена — только явные персональные поля. Что не поймали — добьёт ревью и дайджест.
 *
 * Чистые функции — под тестом, без сети и без ФС в ядре (`scanSource`).
 */

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
  + '|passport|birth_date|birthday|whatsapp|telegram|address|snils|inn|phone|email|e_mail|mobile|tel|contacts?';
const CONTACT_FIELD = new RegExp(`\\.\\s*(?:[a-z0-9$]+_)*(?:${CONTACT_WORD})s?\\b`, 'i');

/** Явные персональные имена (не «название вулкана»): по полю или по владельцу. */
export const PERSONAL_NAME_FIELD =
  /\b(customer|client|full|first|last|user|guest|traveler|traveller|tourist|contact|passenger|buyer|payer)_name\b/i;
export const PERSONAL_OWNER_NAME =
  /\b(lead|leads|l|booking|bookings|b|user|users|u|member|members|m|guest|guests|g|client|customer|traveler|traveller|tourist|passenger|buyer|payer)\s*\.\s*name\b/i;

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
 * Поэтому сначала собираем ПСЕВДОНИМЫ ПД в файле, а потом считаем
 * интерполяцию псевдонима равной интерполяции самого поля.
 *
 * Цепочка бывает длиннее одного шага — в дайджесте она была двухзвенной:
 * `l.phone` → `phone` → строка `leadsStr` → промпт. Поэтому псевдонимы
 * собираются ДО НЕПОДВИЖНОЙ ТОЧКИ: правая часть объявления, в которой уже
 * есть псевдоним ПД, делает псевдонимом и левую.
 */
const DECL_HEAD = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=/g;
/** Деструктуризация: только однозначные контакты. `name` тут слишком част. */
const DESTRUCT = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
const DESTRUCT_CONTACT = new RegExp(
  `^\\s*((?:[a-z0-9$]+_)*(?:${CONTACT_WORD})s?)\\s*(?::\\s*([A-Za-z_$][\\w$]*))?\\s*$`, 'i');

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
type Kind = 'contact' | 'name';
const CONTACT_SANITIZERS: ReadonlySet<string> = new Set(['redactPII', 'redact']);
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
 * Псевдонимы ПД в файле: имя локальной переменной → род ПД.
 * Псевдоним, присвоенный СКВОЗЬ redactPII, псевдонимом ПД не является.
 * Ключ здесь — голое имя (для теста и разбора находки); сканер сверяет
 * псевдонимы по областям видимости (`aliasesIn`).
 */
export function pdAliases(src: string): Map<string, 'contact' | 'name'> {
  const code = maskCode(src);
  const out = new Map<string, 'contact' | 'name'>();
  for (const [key, kinds] of aliasesIn(src, code, buildScopes(code))) out.set(nameOfKey(key), kinds.has('contact') ? 'contact' : 'name');
  return out;
}

/**
 * Псевдонимы по областям видимости: ключ — область объявления и имя.
 *
 * До 07.11 псевдоним был общим на файл, и одноимённая переменная другой
 * функции становилась «телефоном»: в `lib/kuzmich/core.ts` текст
 * уведомления оператору (`const text = [… b.phone].join(…)`) делал
 * псевдонимом ПД вопрос туриста `text` в соседней функции. Объявления ищутся
 * в коде без прозы, правая часть читается из исходника — SQL в ней (`u.name
 * as user_name`) остаётся уликой, как и раньше.
 */
function aliasesIn(src: string, code: string, sc: Scopes): Map<string, Set<Kind>> {
  const out = new Map<string, Set<Kind>>();
  const mark = (key: string, kind: Kind): boolean => {
    const kinds = out.get(key) ?? new Set<Kind>();
    if (kinds.has(kind)) return false;
    kinds.add(kind);
    out.set(key, kinds);
    return true;
  };

  // Объявления с правой частью до конца выражения (может быть многострочной).
  const decls: Array<{ key: string; from: number; rhs: string; clean: Array<[number, number]> }> = [];
  DECL_HEAD.lastIndex = 0;
  for (let m = DECL_HEAD.exec(code); m; m = DECL_HEAD.exec(code)) {
    const from = m.index + m[0].length;
    const to = stmtEnd(code, from);
    decls.push({ key: sc.key(m[1], m.index), from, rhs: src.slice(from, to), clean: sanitizedRanges(code, from, to, CONTACT_SANITIZERS) });
  }

  // Контакт — поле вне аргументов redactPII; имя чистка контактов не убирает.
  for (const d of decls) {
    if (CONTACT_FIELD.test(blankRanges(d.rhs, d.from, d.clean))) mark(d.key, 'contact');
    if (PERSONAL_NAME_FIELD.test(d.rhs) || PERSONAL_OWNER_NAME.test(d.rhs)) mark(d.key, 'name');
  }

  DESTRUCT.lastIndex = 0;
  for (let m = DESTRUCT.exec(code); m; m = DESTRUCT.exec(code)) {
    for (const part of m[1].split(',')) {
      const d = DESTRUCT_CONTACT.exec(part);
      if (d) mark(sc.key(d[2] ?? d[1], m.index), 'contact');
    }
  }

  // Неподвижная точка: правая часть, содержащая уже известный псевдоним,
  // делает псевдонимом и левую — тем же родом (контакт — только вне чистки).
  // Проходов немного — цепочки в реальном коде короткие, а предел защищает от патологии.
  for (let pass = 0; pass < 5; pass++) {
    let grew = false;
    for (const d of decls) {
      for (const v of interpolatedVars(d.rhs, d.from, code)) {
        const kinds = out.get(sc.key(v.name, v.at));
        if (!kinds) continue;
        if (kinds.has('contact') && !insideAny(v.at, d.clean) && mark(d.key, 'contact')) grew = true;
        if (kinds.has('name') && mark(d.key, 'name')) grew = true;
      }
    }
    if (!grew) break;
  }

  return out;
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
    // Свойство — не переменная: `x.phone` судит CONTACT_FIELD, а `review.name` не псевдоним `name`.
    if (/(?<!\.)\.\s*$/.test(masked.slice(Math.max(0, pos - 8), pos))) continue;
    if (pos > 0 && /[\w$]/.test(masked[pos - 1])) continue;
    yield { name: id[0], at: base + pos };
  }
}

/** Переменные в `${…}` текста, начатого на `from`. */
function* interpolatedVars(text: string, from: number, code: string): Generator<{ name: string; at: number }> {
  for (const { expr, at } of interpolations(text, code.slice(from, from + text.length))) yield* varsAt(code, from + at + 2, expr.length);
}

function fileMentionsForeignCaller(src: string): boolean {
  return FOREIGN_LLM_CALLERS.some((fn) => src.includes(fn));
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
    for (const names of params) bind(body, names);
    fn(functionName(code, open), body, params);
  }
  ARROW_ONE.lastIndex = 0;
  for (let m = ARROW_ONE.exec(code); m; m = ARROW_ONE.exec(code)) {
    if (NOT_ROOT.has(m[1])) continue;
    const body = bodyAt(m.index + m[0].length);
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
  };
}

/**
 * Присваивание: `const x = …`, `x = …`, `x += …`, поле `this.x = …` и
 * `box.lines = …` (не `==`, `=>`, `<=`, `>=`, `!=`). Поле — тот же ключ, что у
 * корня `this.x` и получателя `box.lines.join(…)`: ребро «собрал в поле, отдал
 * в content:» (четвёртое ревью PR #3104).
 */
const ASSIGN_HEAD = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?\+?=(?![=>])/g;
/** Ключ стока: `content:`/`system:` — значение уходит модели. */
const SINK_KEY_HEAD = /\b(?:content|system)\s*:/g;
/** Зарубежный вызов: `callAIFast(…)` и т. п. */
const FOREIGN_CALL_HEAD = new RegExp(`\\b(?:${FOREIGN_LLM_CALLERS.join('|')})\\s*\\(`, 'g');
/** Слова языка — не имена переменных. */
const NOT_ROOT = new Set([
  'this', 'await', 'new', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'return', 'async', 'function',
  'const', 'let', 'var', 'if', 'else', 'as', 'satisfies', 'true', 'false', 'null', 'undefined', 'yield',
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
 *   `ctx.filter(Boolean).join('\n')`, `this.ctx.join('\n')` и `box.lines.join(…)`
 *   → ctx, ctx, lines;
 * - аргументы вызова — тоже корни: что вызов делает с текстом, страж не
 *   знает (`Object.values(parts).join(…)`, `format(ctx)`). Внутри redactPII —
 *   нет: там ПД уже нет. Прежняя узость («аргументы — только у стока») на
 *   первой пробе берегла от SQL и fetch; с маской кода, областями видимости и
 *   находкой только по полю ПД она ложных находок по репозиторию не даёт, а
 *   пропускала целый класс записи (ревью PR #3104);
 * - ключ объектного литерала — не корень; `${…}` в бэктиках — выражения.
 */
function rootsAt(code: string, from: number, to: number, cutters: ReadonlySet<string>, out: Root[] = [], sanitized = false): Root[] {
  // Кадры скобок: вызов ли, и не redactPII ли он.
  const frames: boolean[] = [];
  const inSafe = () => sanitized || frames.includes(true);
  let i = from;
  while (i < to) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') {
      const t = templateParts(code, i);
      for (const e of t.exprs) rootsAt(code, e.from, e.to, cutters, out, inSafe());
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
      const isKey = after.startsWith(':') && !after.startsWith('::') && /(?:^|[{,])$/.test(before);
      // Свойство-получатель метода — корень: `box.lines.join(…)` → lines (как у push).
      const isReceiver = isProp && /^\??\.\s*[A-Za-z_$][\w$]*\s*\(/.test(after);
      if (!NOT_ROOT.has(name) && !isCallee && !isKey && (!isProp || viaThis || isReceiver) && !inSafe()) {
        out.push({ name, at: i });
      }
      i = j;
      continue;
    }
    if (c === '(') {
      const before = tailBefore(code, from, i);
      const call = CALL_BEFORE.test(before) && !KEYWORD_BEFORE.test(before);
      frames.push(call && cutters.has(/([A-Za-z_$][\w$]*)$/.exec(before)?.[1] ?? ''));
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

/** `X.push(…)`, `X.unshift(…)`, `X.add(…)`, `X.concat(…)` — X получает текст аргументов. */
const PUSH_CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|add|concat)\s*\(/g;

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
function literalsIn(code: string, span: FlowSpan, cutters: ReadonlySet<string>): { literals: number[]; callees: string[] } {
  const frames: Array<{ call: boolean; callee: string }> = [];
  const literals: number[] = [];
  const callees: string[] = [];
  const passes = () => frames.every((f) => !f.call || !cutters.has(f.callee));
  let i = span.from;
  while (i < span.to) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') { if (passes()) literals.push(i); i = templateParts(code, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') {
      const before = tailBefore(code, span.from, i);
      const call = c === '(' && CALL_BEFORE.test(before) && !KEYWORD_BEFORE.test(before);
      const callee = call ? (/([A-Za-z_$][\w$]*)$/.exec(before)?.[1] ?? '') : '';
      // Своё имя или метод через this — не `obj.method(`: чужой объект файлом не описан.
      if (callee && passes() && !cutters.has(callee) && /(?:^|[^\w$.])(?:this\s*\??\.\s*)?[A-Za-z_$][\w$]*$/.test(before)) callees.push(callee);
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
function promptFlow(code: string, sc: Scopes, literals: TemplateLiteral[], hasForeign: boolean, cutters: ReadonlySet<string>): PromptFlow {
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
    let grew = add(rootsAt(code, span.from, span.to, cutters));
    const inner = literalsIn(code, span, cutters);
    for (const at of inner.literals) if (literalIn(at)) grew = true;
    for (const name of inner.callees) for (const r of returnsOf(name)) if (take(r)) grew = true;
    return grew;
  };

  // Сток `content:` и вызов — только в файле с зарубежным вызовом (то же
  // условие, что у метки `content`); переменная `*prompt*` — промпт везде.
  if (hasForeign) {
    SINK_KEY_HEAD.lastIndex = 0;
    for (let m = SINK_KEY_HEAD.exec(code); m; m = SINK_KEY_HEAD.exec(code)) {
      const from = m.index + m[0].length;
      take({ from, to: from + valueAfter(code, from).length });
    }
    FOREIGN_CALL_HEAD.lastIndex = 0;
    for (let m = FOREIGN_CALL_HEAD.exec(code); m; m = FOREIGN_CALL_HEAD.exec(code)) {
      // Объявление самой функции (`async function callAIFast(prompt: string)`) — не вызов.
      if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
      const open = m.index + m[0].length - 1;
      take({ from: open + 1, to: open + 1 + argsAfter(code, open).length });
    }
  }
  for (const lit of literals) {
    if (isPromptLiteral(lit.label, hasForeign)) literalIn(lit.start);
  }

  const edges: Array<{ key: string; span: FlowSpan }> = [];
  ASSIGN_HEAD.lastIndex = 0;
  for (let m = ASSIGN_HEAD.exec(code); m; m = ASSIGN_HEAD.exec(code)) {
    const from = m.index + m[0].length;
    const key = sc.key(m[1], m.index);
    edges.push({ key, span: { from, to: stmtEnd(code, from) } });
    if (/prompt|instruction/i.test(m[1])) reach.add(key);
  }
  PUSH_CALL.lastIndex = 0;
  for (let m = PUSH_CALL.exec(code); m; m = PUSH_CALL.exec(code)) {
    const open = m.index + m[0].length - 1;
    edges.push({ key: sc.key(m[1], m.index), span: { from: open + 1, to: open + 1 + argsAfter(code, open).length } });
  }
  // Аргумент вызова функции файла → её параметр (пятое ревью PR #3104: тонкая
  // обёртка `askModel(prompt)` над зарубежным вызовом прятала литерал-аргумент).
  CALL_SITE.lastIndex = 0;
  for (let m = CALL_SITE.exec(code); m; m = CALL_SITE.exec(code)) {
    const fns = sc.functions.get(m[1]);
    if (!fns || /\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const args = argSpans(code, open);
    const close = args.length ? args[args.length - 1].to : open;
    // Заголовок функции или метода (`name(…) {`, `name(…): T {`, `(…) =>`) — не вызов.
    const k = skipWs(code, close + 1);
    if (code[k] === '{' || code.startsWith('=>', k) || (code[k] === ':' && afterReturnType(code, k + 1))) continue;
    for (const b of fns) {
      b.params.forEach((names, pos) => {
        const arg = args[pos];
        if (arg) for (const name of names) edges.push({ key: `${b.scope}:${name}`, span: arg });
      });
    }
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

/** Имена переменных, текст которых доходит до модели, — для теста и разбора находки. */
export function promptFlowOf(src: string): { reach: string[] } {
  const code = maskCode(src);
  const f = promptFlow(code, buildScopes(code), extractTemplateLiterals(src, code), fileMentionsForeignCaller(src), CONTACT_SANITIZERS);
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
const CONTACT_NAMED = new RegExp(`^(?:[a-z0-9$]+_)*(?:${CONTACT_WORD})s?$`, 'i');

/** Контакт в `${…}` на [base, base+len): поле, переменная с именем контакта или псевдоним — вне аргументов redactPII. */
function contactIn(code: string, base: number, len: number, aliases: Map<string, Set<Kind>>, sc: Scopes): boolean {
  const clean = sanitizedRanges(code, base, base + len, CONTACT_SANITIZERS);
  // Поле ПД — обращение в коде, а не текст строки: адрес API Telegram в
  // строке (`…//api.telegram…`) полем `.telegram` не является.
  const visible = blankRanges(code.slice(base, base + len), base, clean).replace(SERVICE_CONTACT, (m) => ' '.repeat(m.length));
  if (CONTACT_FIELD.test(visible)) return true;
  for (const v of varsAt(code, base, len)) {
    if (insideAny(v.at, clean)) continue;
    if (v.name !== 'mchs_phone' && CONTACT_NAMED.test(v.name)) return true;
    if (aliases.get(sc.key(v.name, v.at))?.has('contact')) return true;
  }
  return false;
}

/** Имя человека в `${…}`: поле или псевдоним — redactPII его не убирает. */
function nameIn(code: string, base: number, len: number, aliases: Map<string, Set<Kind>>, sc: Scopes): boolean {
  const exprCode = code.slice(base, base + len);
  if (PERSONAL_NAME_FIELD.test(exprCode) || PERSONAL_OWNER_NAME.test(exprCode)) return true;
  for (const v of varsAt(code, base, len)) if (aliases.get(sc.key(v.name, v.at))?.has('name')) return true;
  return false;
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
  const hasForeign = fileMentionsForeignCaller(src);
  // Без зарубежного вызова, промпта по метке и переменной `*prompt*` — смотреть нечего.
  if (!hasForeign && !/prompt|instruction/i.test(src)) return findings;
  const code = maskCode(src);
  const literals = extractTemplateLiterals(src, code);
  const sc = buildScopes(code);
  const aliases = aliasesIn(src, code, sc);
  const flowContact = promptFlow(code, sc, literals, hasForeign, CONTACT_SANITIZERS);
  const flowName = promptFlow(code, sc, literals, hasForeign, NO_SANITIZERS);
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
      const kind: Kind | null = forContact && contactIn(code, base, expr.length, aliases, sc) ? 'contact'
        : forName && nameIn(code, base, expr.length, aliases, sc) ? 'name' : null;
      if (!kind) continue;

      // Номер строки: смещение открытия литерала + смещение интерполяции в теле.
      const absOffset = lit.start + 1 + at;
      const line = src.slice(0, absOffset).split('\n').length;
      const context = lit.receiver ? `${lit.receiver}.${lit.label}` : lit.label || 'выражение';
      findings.push({ file, line, expr: expr.trim(), kind, context });
    }
  }
  return findings;
}
