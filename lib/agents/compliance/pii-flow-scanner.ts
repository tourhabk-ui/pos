/**
 * Compliance Sentinel — детерминированный сканер утечки ПД в зарубежные LLM.
 *
 * 152-ФЗ минимизирует трансграничную передачу персональных данных. Платформа
 * хостится в РФ, но модели `callAIFast`/`callAIWaterfall`/`callAIWithModel`/
 * `callAIDecision` ходят в зарубежные провайдеры (DeepSeek/Gemini/OpenRouter).
 * Значит телефон/почта/имя туриста НЕ должны попадать в текст промпта без
 * псевдонимизации (`redactPII` или плейсхолдер `{name}`).
 *
 * Это НЕ ИИ-«юрист» и НЕ дата-флоу-анализатор. Это узкий детерминированный
 * страж: он читает исходники, находит ТЕКСТ ПРОМПТА (template literal у
 * переменной `*prompt*`, значение `content:`, либо прямой аргумент вызова
 * зарубежной модели) и ловит внутри него интерполяцию однозначных ПД-полей
 * (`.phone`, `.email`, персональные `*_name`/`lead.name`) без чистки.
 *
 * Философия репо (CLAUDE.md §8): лучше узкий детерминированный guard с
 * allowlist, чем абзацы в промпте агента. Ложные срабатывания дороги (блокируют
 * CI), поэтому правило точечное: телефон/почта не двусмысленны (у места их нет),
 * имена — только явные персональные поля. Что не поймали — добьёт ревью и дайджест.
 *
 * Чистые функции — под тестом, без сети и без ФС в ядре (`scanSource`).
 */

/** Функции, уходящие в ЗАРУБЕЖНЫЙ LLM. Прямой аргумент-бэктик такого вызова — промпт. */
export const FOREIGN_LLM_CALLERS = [
  'callAIFast',
  'callAIWaterfall',
  'callAIWithModel',
  'callAIWithModelDirect',
  'callAIDecision',
  'callDeepSeek',
  'callOpenrouter',
  'callOpenRouterModel',
  // Дверь в Google зовут `callGeminiDirect` (водопад) и `callGeminiTranscribe`
  // (голос в Telegram/MAX). Раньше здесь стоял `callGemini` — вариант через
  // OpenRouter, которого не звал никто: страж сторожил не ту дверь.
  'callGeminiDirect',
  'callGeminiTranscribe',
] as const;

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

const IDENT_G = /[A-Za-z_$][\w$]*/g;

/** Санкционированная чистка/псевдонимизация — интерполяция сквозь неё безопасна. */
/**
 * Плейсхолдер `{name}` — безопасен, но ТОЛЬКО когда он именно плейсхолдер.
 * Без проверки на `$` перед скобкой сюда попадала любая интерполяция
 * `${name}` — то есть ровно тот случай, когда в промпт кладут имя из
 * локальной переменной. Страж считал такую строку очищенной.
 */
const SAFE_WRAP = /\bredactPII\s*\(|\bredact\s*\(|(?<!\$)\{name\}/;

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

/** Читает идентификатор, заканчивающийся на позиции `end` (эксклюзивно), справа налево. */
function identBefore(src: string, end: number): string {
  let i = end;
  while (i > 0 && IDENT_CHAR.test(src[i - 1])) i--;
  return src.slice(i, end);
}

/**
 * Извлекает template literals с их контекст-метками. Учитывает строки, коменты
 * и вложенные `${…}` (включая вложенные бэктики). Метка — идентификатор перед
 * `= \``, `+= \``, `: \`` или `(\``; у `X.push(\`` ещё и получатель X.
 */
function extractTemplateLiterals(src: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];

  // Рекурсивный разбор одного бэктик-литерала, начиная с позиции открывающего `.
  // Возвращает индекс сразу за закрывающим бэктиком.
  function parseTemplate(open: number, label: string, receiver?: string): number {
    let body = '';
    let i = open + 1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        body += src[i] + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '`') {
        out.push({ label, start: open, body, ...(receiver ? { receiver } : {}) });
        return i + 1;
      }
      if (ch === '$' && src[i + 1] === '{') {
        // Вложенная интерполяция — пройти по балансу фигурных скобок, попутно
        // ныряя во вложенные строки/бэктики, чтобы не сбиться на `}` внутри них.
        body += '${';
        i += 2;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '{') { depth++; body += c; i++; }
          else if (c === '}') { depth--; if (depth > 0) body += c; i++; }
          else if (c === '`') { const end = parseTemplate(i, ''); body += src.slice(i, end); i = end; }
          else if (c === '"' || c === "'") { const end = skipString(src, i); body += src.slice(i, end); i = end; }
          else { body += c; i++; }
        }
        body += '}';
        continue;
      }
      body += ch;
      i++;
    }
    out.push({ label, start: open, body, ...(receiver ? { receiver } : {}) });
    return i;
  }

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Комментарии
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    // Обычные строки
    if (ch === '"' || ch === "'") { i = skipString(src, i); continue; }
    // Template literal (верхнего уровня)
    if (ch === '`') {
      let j = i - 1;
      while (j > 0 && /\s/.test(src[j])) j--;
      const prev = src[j];
      let label = '';
      let receiver: string | undefined;
      if (prev === '=' || prev === ':' || prev === '(') {
        let k = j;
        // `x += \`…\`` — дописывание к переменной: метка — сама переменная.
        if (prev === '=' && src[k - 1] === '+') k--;
        while (k > 0 && /\s/.test(src[k - 1])) k--;
        label = identBefore(src, k);
        const head = k - label.length;
        if (prev === '(' && label === 'push' && src[head - 1] === '.') receiver = identBefore(src, head - 1) || undefined;
      }
      i = parseTemplate(i, label, receiver);
      continue;
    }
    i++;
  }
  return out;
}

/** Пропускает строковый литерал, начиная с кавычки на позиции `open`. */
function skipString(src: string, open: number): number {
  const quote = src[open];
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Все `${…}`-интерполяции литерала с их смещением внутри body. */
function interpolations(body: string): Array<{ expr: string; at: number }> {
  const res: Array<{ expr: string; at: number }> = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      const at = i;
      i += 2;
      let depth = 1;
      let expr = '';
      while (i < body.length && depth > 0) {
        const c = body[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
        expr += c;
        i++;
      }
      res.push({ expr, at });
    } else {
      i++;
    }
  }
  return res;
}

/**
 * Псевдонимы ПД в файле: имя локальной переменной → род ПД.
 * Псевдоним, присвоенный СКВОЗЬ redactPII, псевдонимом ПД не является.
 */
export function pdAliases(src: string): Map<string, 'contact' | 'name'> {
  const out = new Map<string, 'contact' | 'name'>();

  // Объявления с правой частью до конца выражения (может быть многострочной).
  const decls: Array<{ alias: string; rhs: string }> = [];
  DECL_HEAD.lastIndex = 0;
  for (let m = DECL_HEAD.exec(src); m; m = DECL_HEAD.exec(src)) {
    decls.push({ alias: m[1], rhs: rhsAfter(src, m.index + m[0].length) });
  }

  for (const { alias, rhs } of decls) {
    if (SAFE_WRAP.test(rhs)) continue;
    if (CONTACT_FIELD.test(rhs)) out.set(alias, 'contact');
    else if (PERSONAL_NAME_FIELD.test(rhs) || PERSONAL_OWNER_NAME.test(rhs)) out.set(alias, 'name');
  }

  DESTRUCT.lastIndex = 0;
  for (let m = DESTRUCT.exec(src); m; m = DESTRUCT.exec(src)) {
    for (const part of m[1].split(',')) {
      const d = DESTRUCT_CONTACT.exec(part);
      if (d) out.set(d[2] ?? d[1], 'contact');
    }
  }

  // Неподвижная точка: правая часть, содержащая уже известный псевдоним,
  // делает псевдонимом и левую. Проходов немного — цепочки в реальном коде
  // короткие, а предел защищает от патологии.
  for (let pass = 0; pass < 5; pass++) {
    let grew = false;
    for (const { alias, rhs } of decls) {
      if (out.has(alias) || SAFE_WRAP.test(rhs)) continue;
      const kind = kindByAlias(rhs, out);
      if (kind) { out.set(alias, kind); grew = true; }
    }
    if (!grew) break;
  }

  return out;
}

/** Правая часть объявления: от `=` до конца выражения, с учётом вложенности. */
function rhsAfter(src: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
    else if (c === '\n' && depth === 0) {
      // Перенос на нулевой вложенности заканчивает выражение, если следующая
      // непустая строка не продолжает его точкой или оператором.
      const rest = src.slice(i + 1, i + 200);
      if (!/^\s*[.?:|&+]/.test(rest)) break;
    }
  }
  return src.slice(from, i);
}

/** Есть ли в тексте интерполяция известного псевдонима ПД. */
function kindByAlias(text: string, aliases: Map<string, 'contact' | 'name'>): 'contact' | 'name' | null {
  for (const { expr } of interpolations(text)) {
    IDENT_G.lastIndex = 0;
    for (let id = IDENT_G.exec(expr); id; id = IDENT_G.exec(expr)) {
      const k = aliases.get(id[0]);
      if (k) return k;
    }
  }
  return null;
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

/** Присваивание: `const x = …`, `x = …`, `x += …` (не `==`, `=>`, `<=`, `>=`, `!=`). */
const ASSIGN_HEAD = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?\+?=(?![=>])/g;
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

/** Конец бэктик-литерала, начатого на `open`, и выражения его `${…}`. */
function templateSpan(text: string, open: number): { end: number; exprs: string[] } {
  const exprs: string[] = [];
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
        else if (c === '`') i = templateSpan(text, i).end;
        else if (c === '"' || c === "'") i = skipString(text, i);
        else i++;
      }
      exprs.push(text.slice(from, Math.max(from, i - 1)));
      continue;
    }
    i++;
  }
  return { end: i, exprs };
}

/**
 * Корни выражения — имена переменных, из которых собран его текст.
 * - имя свойства после точки — не корень, кроме `this.x` (это x);
 * - имя вызываемой функции — не корень; получатель метода — корень:
 *   `ctx.filter(Boolean).join('\n')` и `this.ctx.join('\n')` → ctx;
 * - аргументы вызова — корни только при `intoCalls`. Значение стока
 *   `withContext(x)` несёт x в промпт, а `const rows = query(SQL, …)` SQL в
 *   rows не несёт: широкое «всё, что течёт» на пробе по репозиторию затянуло
 *   SQL, fetch и заголовки — шум вместо стража;
 * - ключ объектного литерала — не корень; строки пропускаются, `${…}` в
 *   бэктиках разбираются как выражения.
 */
function rootsOf(expr: string, intoCalls: boolean, out: Set<string> = new Set(), inArgs = false): Set<string> {
  const calls: boolean[] = [];
  const inCallArgs = () => inArgs || calls.includes(true);
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '/' && expr[i + 1] === '/') { const e = expr.indexOf('\n', i); i = e === -1 ? expr.length : e; continue; }
    if (c === '/' && expr[i + 1] === '*') { const e = expr.indexOf('*/', i + 2); i = e === -1 ? expr.length : e + 2; continue; }
    if (c === '"' || c === "'") { i = skipString(expr, i); continue; }
    if (c === '`') {
      const span = templateSpan(expr, i);
      if (!inCallArgs() || intoCalls) for (const e of span.exprs) rootsOf(e, intoCalls, out, inCallArgs());
      i = span.end;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < expr.length && /[\w$]/.test(expr[j])) j++;
      const name = expr.slice(i, j);
      const before = expr.slice(0, i).replace(/\s+$/, '');
      const after = expr.slice(j).replace(/^\s+/, '');
      // Одна точка (не `...x`) — свойство; `this.x` — само имя x.
      const isProp = /(?<!\.)\.$/.test(before);
      const viaThis = isProp && /(?:^|[^\w$.])this\s*\??\.$/.test(before);
      const isCallee = after.startsWith('(') || after.startsWith('?.(');
      const isKey = after.startsWith(':') && !after.startsWith('::') && /(?:^|[{,])$/.test(before);
      if (!NOT_ROOT.has(name) && !isCallee && !isKey && (!isProp || viaThis) && (!inCallArgs() || intoCalls)) out.add(name);
      i = j;
      continue;
    }
    if (c === '(') {
      const before = expr.slice(0, i).replace(/\s+$/, '');
      calls.push(CALL_BEFORE.test(before) && !KEYWORD_BEFORE.test(before));
      i++;
      continue;
    }
    if (c === '[' || c === '{') { calls.push(false); i++; continue; }
    if (c === ')' || c === ']' || c === '}') { calls.pop(); i++; continue; }
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
    if (c === '`') { i = templateSpan(src, i).end; continue; }
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
    if (c === '`') { i = templateSpan(src, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    i++;
  }
  return src.slice(open + 1, Math.max(open + 1, i - 1));
}

/**
 * Имена, текст которых доходит до зарубежной модели: неподвижная точка.
 *
 * Дыра, найденная ревьюером deepseek-flash в пробе 07.11 (run 2, откат #2506):
 *
 *     if (tourist_phone) ctx.push(`Тел: ${sanitizePromptInput(tourist_phone).text}`);
 *     if (ctx.length) systemContent += `\n\nСОБЕСЕДНИК:\n${ctx.join('\n')}`;
 *     return [{ role: 'system', content: systemContent }, …];
 *
 * Ни один литерал не был «промптом» по метке (`push`, `+=` без имени), и страж
 * молчал. Ревью PR #3104 (тот же ревьюер) нашло, где первая редакция рвала
 * цепочку: склейка через цепочку методов (`ctx.filter(Boolean).join`) и
 * `this.ctx`, промежуточная переменная (`const joined = ctx.join(…)`), значение
 * стока не голым именем (`content: x.trim()`, `withContext(x)`, `BASE + x`).
 *
 * Поэтому — не узоры, а корни выражений (`rootsOf`) и неподвижная точка:
 * - начало — корни значений `content:`/`system:`, аргументов зарубежного
 *   вызова и `${…}` в промпт-литералах по метке (вместе с аргументами
 *   вызовов: `withContext(x)` несёт x);
 * - имя в множестве — корни правой части его присваивания (без аргументов
 *   вызовов) и `${…}` литералов, записанных в него или положенных в него `push`.
 * Только в файле с зарубежным вызовом — то же условие, что у метки `content`.
 */
function promptFlow(src: string, literals: TemplateLiteral[], hasForeign: boolean): { reach: Set<string> } {
  const reach = new Set<string>();
  if (!hasForeign) return { reach };
  const add = (names: Iterable<string>): boolean => {
    let grew = false;
    for (const n of names) if (!reach.has(n)) { reach.add(n); grew = true; }
    return grew;
  };

  SINK_KEY_HEAD.lastIndex = 0;
  for (let m = SINK_KEY_HEAD.exec(src); m; m = SINK_KEY_HEAD.exec(src)) {
    add(rootsOf(valueAfter(src, m.index + m[0].length), true));
  }
  FOREIGN_CALL_HEAD.lastIndex = 0;
  for (let m = FOREIGN_CALL_HEAD.exec(src); m; m = FOREIGN_CALL_HEAD.exec(src)) {
    // Объявление самой функции (`async function callAIFast(prompt: string)`) — не вызов.
    if (/\bfunction\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
    add(rootsOf(argsAfter(src, m.index + m[0].length - 1), true));
  }
  for (const lit of literals) {
    if (!isPromptLiteral(lit.label, hasForeign)) continue;
    for (const { expr } of interpolations(lit.body)) add(rootsOf(expr, true));
  }

  const assigns: Array<{ name: string; rhs: string }> = [];
  ASSIGN_HEAD.lastIndex = 0;
  for (let m = ASSIGN_HEAD.exec(src); m; m = ASSIGN_HEAD.exec(src)) {
    assigns.push({ name: m[1], rhs: rhsAfter(src, m.index + m[0].length) });
  }
  // Цепочки в коде короткие; предел — от патологии.
  for (let pass = 0; pass < 12; pass++) {
    let grew = false;
    for (const a of assigns) if (reach.has(a.name) && add(rootsOf(a.rhs, false))) grew = true;
    for (const lit of literals) {
      const into = (lit.label !== '' && reach.has(lit.label)) || (lit.receiver !== undefined && reach.has(lit.receiver));
      if (!into) continue;
      for (const { expr } of interpolations(lit.body)) if (add(rootsOf(expr, true))) grew = true;
    }
    if (!grew) break;
  }
  return { reach };
}

/** Имена, текст которых доходит до модели, — для теста и разбора находки. */
export function promptFlowOf(src: string): { reach: string[] } {
  const f = promptFlow(src, extractTemplateLiterals(src), fileMentionsForeignCaller(src));
  return { reach: [...f.reach].sort() };
}

/**
 * Телефон службы, а не человека: МЧС у маршрута (kamchatka_routes.mchs_phone,
 * CLAUDE.md §10) — публичный номер для консультации. Персональными данными не
 * является, и находкой его интерполяция не будет.
 */
const SERVICE_CONTACT = /\.\s*mchs_phone\b/gi;

/** Сканирует ОДИН исходник. Чистая функция — принимает путь и содержимое. */
export function scanSource(file: string, src: string): PIIFinding[] {
  const findings: PIIFinding[] = [];
  const hasForeign = fileMentionsForeignCaller(src);
  const literals = extractTemplateLiterals(src);
  const aliases = pdAliases(src);
  const flow = promptFlow(src, literals, hasForeign);

  for (const lit of literals) {
    const intoPrompt = (lit.label !== '' && flow.reach.has(lit.label)) || (lit.receiver !== undefined && flow.reach.has(lit.receiver));
    if (!isPromptLiteral(lit.label, hasForeign) && !intoPrompt) continue;

    for (const { expr, at } of interpolations(lit.body)) {
      if (SAFE_WRAP.test(expr)) continue;
      let kind: 'contact' | 'name' | null = null;
      if (CONTACT_FIELD.test(expr.replace(SERVICE_CONTACT, ''))) kind = 'contact';
      else if (PERSONAL_NAME_FIELD.test(expr) || PERSONAL_OWNER_NAME.test(expr)) kind = 'name';
      if (!kind) {
        // Псевдоним: `${name}`, где выше `const name = l.name`.
        IDENT_G.lastIndex = 0;
        for (let id = IDENT_G.exec(expr); id; id = IDENT_G.exec(expr)) {
          const viaAlias = aliases.get(id[0]);
          if (viaAlias) { kind = viaAlias; break; }
        }
      }
      if (!kind) continue;

      // Номер строки: смещение открытия литерала + смещение интерполяции в теле.
      const absOffset = lit.start + 1 + at;
      const line = src.slice(0, absOffset).split('\n').length;
      findings.push({ file, line, expr: expr.trim(), kind, context: lit.receiver ? `${lit.receiver}.push` : lit.label });
    }
  }
  return findings;
}
