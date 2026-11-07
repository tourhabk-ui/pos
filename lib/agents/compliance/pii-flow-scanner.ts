/**
 * Compliance Sentinel — детерминированный сканер утечки ПД в зарубежные LLM.
 *
 * 152-ФЗ минимизирует трансграничную передачу персональных данных. Платформа
 * хостится в РФ, но модели `callAIFast`/`callAIWaterfall`/`callAIWithModel`/
 * `callAIDecision` ходят в зарубежные провайдеры (DeepSeek/Gemini/OpenRouter).
 * Значит телефон/почта/имя туриста НЕ должны попадать в текст промпта без
 * псевдонимизации (`redactPII` или плейсхолдер `{name}`).
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

/** Методы, кладущие значение в коллекцию: `X.push(…)` — X получает текст. */
const PUSHERS = new Set(['push', 'unshift', 'add', 'concat']);

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
        if (prev === '(' && PUSHERS.has(label) && src[head - 1] === '.') receiver = identBefore(src, head - 1) || undefined;
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
 * Ключ здесь — голое имя (для теста и разбора находки); сканер сверяет
 * псевдонимы по областям видимости (`aliasesIn`).
 */
export function pdAliases(src: string): Map<string, 'contact' | 'name'> {
  const code = maskCode(src);
  const out = new Map<string, 'contact' | 'name'>();
  for (const [key, kind] of aliasesIn(src, code, buildScopes(code))) out.set(nameOfKey(key), kind);
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
function aliasesIn(src: string, code: string, sc: Scopes): Map<string, 'contact' | 'name'> {
  const out = new Map<string, 'contact' | 'name'>();

  // Объявления с правой частью до конца выражения (может быть многострочной).
  const decls: Array<{ key: string; from: number; rhs: string }> = [];
  DECL_HEAD.lastIndex = 0;
  for (let m = DECL_HEAD.exec(code); m; m = DECL_HEAD.exec(code)) {
    const from = m.index + m[0].length;
    decls.push({ key: sc.key(m[1], m.index), from, rhs: src.slice(from, stmtEnd(code, from)) });
  }

  for (const { key, rhs } of decls) {
    if (SAFE_WRAP.test(rhs)) continue;
    if (CONTACT_FIELD.test(rhs)) out.set(key, 'contact');
    else if (PERSONAL_NAME_FIELD.test(rhs) || PERSONAL_OWNER_NAME.test(rhs)) out.set(key, 'name');
  }

  DESTRUCT.lastIndex = 0;
  for (let m = DESTRUCT.exec(code); m; m = DESTRUCT.exec(code)) {
    for (const part of m[1].split(',')) {
      const d = DESTRUCT_CONTACT.exec(part);
      if (d) out.set(sc.key(d[2] ?? d[1], m.index), 'contact');
    }
  }

  // Неподвижная точка: правая часть, содержащая уже известный псевдоним,
  // делает псевдонимом и левую. Проходов немного — цепочки в реальном коде
  // короткие, а предел защищает от патологии.
  for (let pass = 0; pass < 5; pass++) {
    let grew = false;
    for (const { key, from, rhs } of decls) {
      if (out.has(key) || SAFE_WRAP.test(rhs)) continue;
      const kind = aliasInInterpolations(rhs, from, code, sc, out);
      if (kind) { out.set(key, kind); grew = true; }
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

/** Переменные в `${…}` текста, начатого на `from`: позиция в коде без прозы. */
function* interpolatedVars(text: string, from: number, code: string): Generator<{ name: string; at: number }> {
  for (const { expr, at } of interpolations(text)) {
    const base = from + at + 2;
    const masked = code.slice(base, base + expr.length);
    for (const id of masked.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const pos = id.index ?? 0;
      // Свойство — не переменная: `x.phone` судит CONTACT_FIELD, а `review.name` не псевдоним `name`.
      if (/(?<!\.)\.\s*$/.test(masked.slice(Math.max(0, pos - 8), pos))) continue;
      if (pos > 0 && /[\w$]/.test(masked[pos - 1])) continue;
      yield { name: id[0], at: base + pos };
    }
  }
}

/** Псевдоним ПД среди переменных в `${…}` текста. */
function aliasInInterpolations(
  text: string, from: number, code: string, sc: Scopes, aliases: Map<string, 'contact' | 'name'>,
): 'contact' | 'name' | null {
  for (const v of interpolatedVars(text, from, code)) {
    const k = aliases.get(sc.key(v.name, v.at));
    if (k) return k;
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

/** Слова, после которых `/` начинает регулярное выражение, а не деление. */
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/;

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
  const regexStart = (i: number): boolean => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const p = out[j];
    // `)`, `]`, `}` и `<` (JSX `</div>`) — деление или разметка, не выражение.
    if ('(,=:[!&|?{;+-*%~^'.includes(p)) return true;
    if (/[\w$]/.test(p)) return REGEX_AFTER_WORD.test(out.slice(Math.max(0, j - 11), j + 1).join(''));
    return false;
  };
  const regexEnd = (open: number): number => {
    let i = open + 1;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') return -1;
      if (c === '\\') { i += 2; continue; }
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      else if (c === '/') { i++; while (i < src.length && /[a-z]/i.test(src[i])) i++; return i; }
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
      if (c === '"' || c === "'") { const end = skipString(src, i); blank(i + 1, end - 1); i = end; continue; }
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
/** Тело функции: блок `{…}` или выражение-тело стрелки. */
interface FnBody { from: number; to: number; block: boolean }
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
  const fn = (name: string, scope: number) => {
    const s = scopes[scope];
    const body: FnBody = { from: s.from, to: s.to, block: code[s.from] === '{' && blockAt.get(s.from) === scope };
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
    for (const part of splitTop(code.slice(open + 1, close))) bind(body, bindingNames(part));
    fn(functionName(code, open), body);
  }
  ARROW_ONE.lastIndex = 0;
  for (let m = ARROW_ONE.exec(code); m; m = ARROW_ONE.exec(code)) {
    if (NOT_ROOT.has(m[1])) continue;
    const body = bodyAt(m.index + m[0].length);
    bind(body, [m[1]]);
    fn(functionName(code, m.index), body);
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
 * - аргументы вызова — корни только при `intoCalls`. Значение стока
 *   `withContext(x)` несёт x в промпт, а `const rows = query(SQL, …)` SQL в
 *   rows не несёт: широкое «всё, что течёт» на пробе по репозиторию затянуло
 *   SQL, fetch и заголовки — шум вместо стража;
 * - ключ объектного литерала — не корень; `${…}` в бэктиках — выражения.
 */
function rootsAt(code: string, from: number, to: number, intoCalls: boolean, out: Root[] = [], inArgs = false): Root[] {
  const calls: boolean[] = [];
  const inCallArgs = () => inArgs || calls.includes(true);
  let i = from;
  while (i < to) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); continue; }
    if (c === '`') {
      const t = templateParts(code, i);
      if (!inCallArgs() || intoCalls) for (const e of t.exprs) rootsAt(code, e.from, e.to, intoCalls, out, inCallArgs());
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
      if (!NOT_ROOT.has(name) && !isCallee && !isKey && (!isProp || viaThis || isReceiver) && (!inCallArgs() || intoCalls)) {
        out.push({ name, at: i });
      }
      i = j;
      continue;
    }
    if (c === '(') {
      const before = tailBefore(code, from, i);
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

/** Обёртки, после которых ПД в тексте уже нет. */
const SAFE_CALLEES = new Set(['redactPII', 'redact']);
/** `X.push(…)`, `X.unshift(…)`, `X.add(…)`, `X.concat(…)` — X получает текст аргументов. */
const PUSH_CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|add|concat)\s*\(/g;

/** Отрезок кода, текст которого доходит до модели. */
interface FlowSpan { from: number; to: number; intoCalls: boolean }

/**
 * Литералы отрезка и вызовы функций в нём.
 *
 * Литерал — где бы ни стоял: элемент `[…]`, колбэк `map` или `reduce`,
 * аргумент любого вызова. Что вызов делает с текстом, страж не знает, и
 * перечень «несущих» вызовов (был `map`/`flatMap`) обходился следующим же
 * (`reduce`, третье ревью PR #3104) — поэтому проверяется всякий литерал, кроме
 * литерала внутри redactPII. Узость держат имена: переменная из аргументов
 * вызова в поток не идёт (`rows = query(SQL, …)`), а находка — только
 * однозначное поле ПД, имя-контакт или псевдоним.
 *
 * Вызов `name(…)` или `this.name(…)` — кандидат в функцию файла: её результат
 * часть отрезка (`content: line(lead)`, то же ревью).
 */
function literalsIn(code: string, span: FlowSpan): { literals: number[]; callees: string[] } {
  const frames: Array<{ call: boolean; callee: string }> = [];
  const literals: number[] = [];
  const callees: string[] = [];
  const passes = () => frames.every((f) => !f.call || !SAFE_CALLEES.has(f.callee));
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
      if (callee && passes() && !SAFE_CALLEES.has(callee) && /(?:^|[^\w$.])(?:this\s*\??\.\s*)?[A-Za-z_$][\w$]*$/.test(before)) callees.push(callee);
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
  if (!body.block) return [{ from: body.from, to: body.to, intoCalls: false }];
  const nested = all.filter((b) => b !== body && b.from > body.from && b.to <= body.to);
  const spans: FlowSpan[] = [];
  const re = /\breturn\b/g;
  re.lastIndex = body.from;
  for (let m = re.exec(code); m && m.index < body.to; m = re.exec(code)) {
    const at = m.index;
    if (nested.some((b) => at > b.from && at < b.to)) continue;
    const from = at + m[0].length;
    spans.push({ from, to: stmtEnd(code, from), intoCalls: false });
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
 * - переменная в потоке — её правая часть (имена из аргументов вызовов в
 *   поток не идут: `rows = query(SQL, …)` SQL в rows не несёт) и аргументы
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
function promptFlow(code: string, sc: Scopes, literals: TemplateLiteral[], hasForeign: boolean): PromptFlow {
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
    for (const { expr, at: off } of interpolations(lit.body)) {
      const from = at + 1 + off + 2;
      if (take({ from, to: from + expr.length, intoCalls: true })) grew = true;
    }
    return grew;
  };
  const taken = new Set<string>();
  const take = (span: FlowSpan): boolean => {
    const id = `${span.from}:${span.to}:${span.intoCalls}`;
    if (taken.has(id)) return false;
    taken.add(id);
    let grew = add(rootsAt(code, span.from, span.to, span.intoCalls));
    const inner = literalsIn(code, span);
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
      take({ from, to: from + valueAfter(code, from).length, intoCalls: true });
    }
    FOREIGN_CALL_HEAD.lastIndex = 0;
    for (let m = FOREIGN_CALL_HEAD.exec(code); m; m = FOREIGN_CALL_HEAD.exec(code)) {
      // Объявление самой функции (`async function callAIFast(prompt: string)`) — не вызов.
      if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
      const open = m.index + m[0].length - 1;
      take({ from: open + 1, to: open + 1 + argsAfter(code, open).length, intoCalls: true });
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
    edges.push({ key, span: { from, to: stmtEnd(code, from), intoCalls: false } });
    if (/prompt|instruction/i.test(m[1])) reach.add(key);
  }
  PUSH_CALL.lastIndex = 0;
  for (let m = PUSH_CALL.exec(code); m; m = PUSH_CALL.exec(code)) {
    const open = m.index + m[0].length - 1;
    edges.push({ key: sc.key(m[1], m.index), span: { from: open + 1, to: open + 1 + argsAfter(code, open).length, intoCalls: true } });
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
  const f = promptFlow(code, buildScopes(code), extractTemplateLiterals(src), fileMentionsForeignCaller(src));
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

/** Сканирует ОДИН исходник. Чистая функция — принимает путь и содержимое. */
export function scanSource(file: string, src: string): PIIFinding[] {
  const findings: PIIFinding[] = [];
  const hasForeign = fileMentionsForeignCaller(src);
  const literals = extractTemplateLiterals(src);
  // Без зарубежного вызова, промпта по метке и переменной `*prompt*` — смотреть нечего.
  if (!hasForeign && !/prompt|instruction/i.test(src)) return findings;
  const code = maskCode(src);
  const sc = buildScopes(code);
  const aliases = aliasesIn(src, code, sc);
  const flow = promptFlow(code, sc, literals, hasForeign);

  for (const lit of literals) {
    const intoPrompt = flow.literalStarts.has(lit.start)
      || (lit.label !== '' && flow.reach.has(sc.key(lit.label, lit.start)))
      || (lit.receiver !== undefined && flow.reach.has(sc.key(lit.receiver, lit.start)));
    if (!isPromptLiteral(lit.label, hasForeign) && !intoPrompt) continue;

    for (const { expr, at } of interpolations(lit.body)) {
      if (SAFE_WRAP.test(expr)) continue;
      // Поле ПД — обращение в коде, а не текст строки: адрес API Telegram в
      // строке (`…//api.telegram…`) полем `.telegram` не является.
      const base = lit.start + 1 + at + 2;
      const exprCode = code.slice(base, base + expr.length);
      let kind: 'contact' | 'name' | null = null;
      if (CONTACT_FIELD.test(exprCode.replace(SERVICE_CONTACT, ''))) kind = 'contact';
      else if (PERSONAL_NAME_FIELD.test(exprCode) || PERSONAL_OWNER_NAME.test(exprCode)) kind = 'name';
      if (!kind) {
        // Переменная с именем контакта или псевдоним: `${name}`, где выше `const name = l.name`.
        for (const v of interpolatedVars(`\${${expr}}`, lit.start + 1 + at, code)) {
          if (v.name !== 'mchs_phone' && CONTACT_NAMED.test(v.name)) { kind = 'contact'; break; }
          const viaAlias = aliases.get(sc.key(v.name, v.at));
          if (viaAlias) { kind = viaAlias; break; }
        }
      }
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
