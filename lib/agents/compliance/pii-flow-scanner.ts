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

/** Однозначные ПД-поля: телефон и почта. У места/тура/маршрута их нет — ложняков нет. */
const CONTACT_FIELD = /\.\s*(phone|email|phone_number|phonenumber|mobile|tel|e_mail)\b/i;

/** Явные персональные имена (не «название вулкана»): по полю или по владельцу. */
const PERSONAL_NAME_FIELD =
  /\b(customer|client|full|first|last|user|guest|traveler|traveller|tourist|contact|passenger|buyer|payer)_name\b/i;
const PERSONAL_OWNER_NAME =
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
const DESTRUCT_CONTACT = /^\s*(phone|email|phone_number|phonenumber|mobile|tel|e_mail)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/i;

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
 * `= \``, `: \`` или `(\``.
 */
function extractTemplateLiterals(src: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];

  // Рекурсивный разбор одного бэктик-литерала, начиная с позиции открывающего `.
  // Возвращает индекс сразу за закрывающим бэктиком.
  function parseTemplate(open: number, label: string): number {
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
        out.push({ label, start: open, body });
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
    out.push({ label, start: open, body });
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
      if (prev === '=' || prev === ':' || prev === '(') {
        let k = j;
        while (k > 0 && /\s/.test(src[k - 1])) k--;
        label = identBefore(src, k);
      }
      i = parseTemplate(i, label);
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

/** Сканирует ОДИН исходник. Чистая функция — принимает путь и содержимое. */
export function scanSource(file: string, src: string): PIIFinding[] {
  const findings: PIIFinding[] = [];
  const hasForeign = fileMentionsForeignCaller(src);
  const literals = extractTemplateLiterals(src);
  const aliases = pdAliases(src);

  for (const lit of literals) {
    if (!isPromptLiteral(lit.label, hasForeign)) continue;

    for (const { expr, at } of interpolations(lit.body)) {
      if (SAFE_WRAP.test(expr)) continue;
      let kind: 'contact' | 'name' | null = null;
      if (CONTACT_FIELD.test(expr)) kind = 'contact';
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
      findings.push({ file, line, expr: expr.trim(), kind, context: lit.label });
    }
  }
  return findings;
}
